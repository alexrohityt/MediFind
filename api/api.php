<?php
// File: api/api.php
require_once __DIR__ . '/db.php';

$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {

    // ---------------------------------------------------------
    // 1. SESSION CHECK
    // ---------------------------------------------------------
    case 'session':
        if (!empty($_SESSION['user_id'])) {
            json_response('success', 'Logged in', [
                'user' => [
                    'id'        => $_SESSION['user_id'],
                    'full_name' => $_SESSION['full_name'],
                    'role'      => $_SESSION['role']
                ]
            ]);
        } else {
            json_response('guest', 'Not logged in', ['user' => null]);
        }
        break;

    // ---------------------------------------------------------
    // 2. LOGIN & LOGOUT & REGISTER
    // ---------------------------------------------------------
    case 'login':
        $email    = trim($_POST['email'] ?? '');
        $password = $_POST['password'] ?? '';

        $stmt = $pdo->prepare("SELECT * FROM users WHERE email = ? LIMIT 1");
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if ($user && password_verify($password, $user['password_hash'])) {
            if ($user['status'] === 'suspended') {
                json_response('error', 'Your account has been suspended by the administrator.', [], 403);
            }
            session_regenerate_id(true);
            $_SESSION['user_id']   = (int)$user['id'];
            $_SESSION['full_name'] = $user['full_name'];
            $_SESSION['role']      = $user['role'];

            json_response('success', 'Login successful!', ['role' => $user['role']]);
        }
        json_response('error', 'Invalid email or password.', [], 401);
        break;

    case 'register':
        $role      = ($_POST['role'] ?? 'customer') === 'pharmacy' ? 'pharmacy' : 'customer';
        $full_name = trim($_POST['full_name'] ?? '');
        $email     = trim($_POST['email'] ?? '');
        $phone     = trim($_POST['phone'] ?? '');
        $password  = $_POST['password'] ?? '';

        if (strlen($password) < 6) {
            json_response('error', 'Password must be at least 6 characters.', [], 400);
        }

        try {
            $pdo->beginTransaction();
            $hash = password_hash($password, PASSWORD_DEFAULT);
            $stmt = $pdo->prepare("INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)");
            $stmt->execute([$full_name, $email, $phone, $hash, $role]);
            $uid = (int)$pdo->lastInsertId();

            if ($role === 'pharmacy') {
                $pstmt = $pdo->prepare("
                    INSERT INTO pharmacies (user_id, pharmacy_name, license_number, address, city, pincode, phone, verification_status, service_pincodes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                ");
                $pstmt->execute([
                    $uid,
                    trim($_POST['pharmacy_name'] ?? ''),
                    trim($_POST['license_number'] ?? ''),
                    trim($_POST['address'] ?? ''),
                    trim($_POST['city'] ?? ''),
                    trim($_POST['pincode'] ?? ''),
                    $phone,
                    trim($_POST['pincode'] ?? '')
                ]);
            }
            $pdo->commit();
            json_response('success', 'Registration complete! You can now log in.');
        } catch (PDOException $e) {
            $pdo->rollBack();
            json_response('error', 'Email or Drug License Number already exists.', [], 400);
        }
        break;

    case 'logout':
        session_unset();
        session_destroy();
        json_response('success', 'Logged out');
        break;

    // ---------------------------------------------------------
    // 3. SEARCH MEDICINES & NEARBY PHARMACIES
    // ---------------------------------------------------------
    case 'search_medicines':
        $q        = trim($_GET['q'] ?? '');
        $location = trim($_GET['location'] ?? '');
        $sort     = $_GET['sort'] ?? 'price_asc';
        $category = trim($_GET['category'] ?? '');

        $sql = "
            SELECT 
                i.id AS inventory_id, i.stock_quantity, i.price,
                m.id AS medicine_id, m.brand_name, m.generic_name, m.active_ingredient,
                m.strength, m.dosage_form, m.pack_size, m.category, m.requires_prescription,
                p.id AS pharmacy_id, p.pharmacy_name, p.address, p.city, p.pincode,
                p.operating_status, p.delivery_charge, p.estimated_delivery_mins
            FROM inventory i
            INNER JOIN medicines m ON i.medicine_id = m.id
            INNER JOIN pharmacies p ON i.pharmacy_id = p.id
            WHERE p.verification_status = 'verified'
              AND i.is_available = 1
              AND i.stock_quantity > 0
        ";
        $params = [];

        if ($q !== '') {
            $sql .= " AND (m.brand_name LIKE ? OR m.generic_name LIKE ? OR m.active_ingredient LIKE ? OR m.strength LIKE ? OR m.dosage_form LIKE ? OR m.category LIKE ?)";
            $like = "%$q%";
            array_push($params, $like, $like, $like, $like, $like, $like);
        }
        $validCategories = ['Antibiotics', 'Fever & Pain', 'Diabetes Care', 'Cardiac Care'];
        if (in_array($category, $validCategories, true)) {
            $sql .= " AND m.category = ?";
            $params[] = $category;
        }
        if ($location !== '') {
            $sql .= " AND (p.city LIKE ? OR p.pincode LIKE ? OR p.address LIKE ? OR p.service_pincodes LIKE ?)";
            $loc = "%$location%";
            array_push($params, $loc, $loc, $loc, $loc);
        }

        if ($sort === 'stock_desc') {
            $sql .= " ORDER BY i.stock_quantity DESC";
        } elseif ($sort === 'delivery_asc') {
            $sql .= " ORDER BY p.estimated_delivery_mins ASC";
        } else {
            $sql .= " ORDER BY i.price ASC";
        }

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $results = $stmt->fetchAll();

        json_response('success', 'Search results loaded', ['results' => $results]);
        break;

    // ---------------------------------------------------------
    // 4. SUBMIT MEDICINE AVAILABILITY REQUEST (WHEN NOT FOUND)
    // ---------------------------------------------------------
    case 'request_medicine':
        $stmt = $pdo->prepare("
            INSERT INTO medicine_requests (user_id, customer_name, customer_phone, medicine_name, strength_form, pincode)
            VALUES (?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $_SESSION['user_id'] ?? null,
            trim($_POST['customer_name'] ?? ''),
            trim($_POST['customer_phone'] ?? ''),
            trim($_POST['medicine_name'] ?? ''),
            trim($_POST['strength_form'] ?? ''),
            trim($_POST['pincode'] ?? '')
        ]);
        json_response('success', 'Your medicine request has been sent to nearby verified pharmacies!');
        break;

    // ---------------------------------------------------------
    // 5. PLACE ORDER (ATOMIC TRANSACTION + STOCK LOCK + RX UPLOAD)
    // ---------------------------------------------------------
    case 'place_order':
        require_auth('customer');

        $cart_json = $_POST['cart'] ?? '[]';
        $cart      = json_decode($cart_json, true);
        if (empty($cart) || !is_array($cart)) {
            json_response('error', 'Your cart is empty.', [], 400);
        }

        $recipient_name = trim($_POST['recipient_name'] ?? '');
        $phone          = trim($_POST['phone'] ?? '');
        $street_address = trim($_POST['street_address'] ?? '');
        $city           = trim($_POST['city'] ?? '');
        $pincode        = trim($_POST['pincode'] ?? '');
        $payment_method = ($_POST['payment_method'] ?? 'COD') === 'Online' ? 'Online' : 'COD';

        try {
            $pdo->beginTransaction();

            // 1. Save Address
            $addr = $pdo->prepare("INSERT INTO addresses (user_id, recipient_name, phone, street_address, city, pincode) VALUES (?, ?, ?, ?, ?, ?)");
            $addr->execute([$_SESSION['user_id'], $recipient_name, $phone, $street_address, $city, $pincode]);
            $address_id = (int)$pdo->lastInsertId();

            // 2. Lock inventory rows & verify server-side price/stock
            $lock = $pdo->prepare("
                SELECT i.*, m.brand_name, m.requires_prescription, p.delivery_charge
                FROM inventory i
                JOIN medicines m ON i.medicine_id = m.id
                JOIN pharmacies p ON i.pharmacy_id = p.id
                WHERE i.id = ? AND p.verification_status = 'verified'
                FOR UPDATE
            ");

            $subtotal        = 0.0;
            $delivery_charge = 0.0;
            $pharmacy_id     = null;
            $requires_rx     = false;
            $order_lines     = [];

            foreach ($cart as $cItem) {
                $inv_id = (int)($cItem['inventory_id'] ?? 0);
                $qty    = max(1, (int)($cItem['quantity'] ?? 1));

                $lock->execute([$inv_id]);
                $row = $lock->fetch();

                if (!$row || !$row['is_available'] || (int)$row['stock_quantity'] < $qty) {
                    throw new Exception("Insufficient stock for " . ($row['brand_name'] ?? 'selected medicine') . ". Please adjust quantity.");
                }

                $pharmacy_id     = (int)$row['pharmacy_id'];
                $delivery_charge = (float)$row['delivery_charge'];
                if ($row['requires_prescription']) {
                    $requires_rx = true;
                }

                // Deduct stock
                $pdo->prepare("UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ?")->execute([$qty, $inv_id]);

                $unit_price = (float)$row['price'];
                $line_total = $unit_price * $qty;
                $subtotal  += $line_total;

                $order_lines[] = [
                    'medicine_id' => (int)$row['medicine_id'],
                    'quantity'    => $qty,
                    'unit_price'  => $unit_price,
                    'line_total'  => $line_total
                ];
            }

            // 3. Validate Prescription Upload if required
            $rx_filename = null;
            if ($requires_rx) {
                if (empty($_FILES['prescription_file']['name']) || $_FILES['prescription_file']['error'] !== UPLOAD_ERR_OK) {
                    throw new Exception("A valid doctor's prescription file (JPG/PNG/PDF) is mandatory for Rx medicines.");
                }
                $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'application/pdf' => 'pdf'];
                $finfo   = finfo_open(FILEINFO_MIME_TYPE);
                $mime    = finfo_file($finfo, $_FILES['prescription_file']['tmp_name']);
                finfo_close($finfo);

                if (!isset($allowed[$mime])) {
                    throw new Exception("Invalid file format. Only JPG, PNG, or PDF allowed.");
                }
                $rx_filename = 'rx_' . $_SESSION['user_id'] . '_' . bin2hex(random_bytes(6)) . '.' . $allowed[$mime];
                $dest = __DIR__ . '/../uploads/prescriptions/' . $rx_filename;
                if (!move_uploaded_file($_FILES['prescription_file']['tmp_name'], $dest)) {
                    throw new Exception("Failed to save uploaded prescription.");
                }
            }

            // 4. Create Order
            $total_amount = $subtotal + $delivery_charge;
            $order_number = 'MF-' . date('Ymd') . '-' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
            $init_status  = $requires_rx ? 'Prescription Verification Pending' : 'Order Placed';
            $pay_status   = $payment_method === 'Online' ? 'Paid' : 'Pending';

            $ord = $pdo->prepare("
                INSERT INTO orders (order_number, user_id, pharmacy_id, address_id, subtotal, delivery_charge, total_amount, order_status, payment_method, payment_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");
            $ord->execute([$order_number, $_SESSION['user_id'], $pharmacy_id, $address_id, $subtotal, $delivery_charge, $total_amount, $init_status, $payment_method, $pay_status]);
            $order_id = (int)$pdo->lastInsertId();

            // 5. Insert Order Items
            $oi = $pdo->prepare("INSERT INTO order_items (order_id, medicine_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)");
            foreach ($order_lines as $l) {
                $oi->execute([$order_id, $l['medicine_id'], $l['quantity'], $l['unit_price'], $l['line_total']]);
            }

            // 6. Save Prescription reference
            if ($rx_filename) {
                $pdo->prepare("INSERT INTO prescriptions (order_id, user_id, file_name) VALUES (?, ?, ?)")
                    ->execute([$order_id, $_SESSION['user_id'], $rx_filename]);
            }

            $pdo->commit();
            json_response('success', 'Order placed successfully!', ['order_number' => $order_number]);

        } catch (Exception $e) {
            $pdo->rollBack();
            json_response('error', $e->getMessage(), [], 400);
        }
        break;

    // ---------------------------------------------------------
    // 6. TRACK ORDER BY ORDER NUMBER
    // ---------------------------------------------------------
    case 'track_order':
        $order_number = trim($_GET['order_number'] ?? '');
        $stmt = $pdo->prepare("
            SELECT o.*, p.pharmacy_name, p.phone AS pharmacy_phone,
                   a.recipient_name, a.street_address, a.city, a.pincode
            FROM orders o
            JOIN pharmacies p ON o.pharmacy_id = p.id
            JOIN addresses a ON o.address_id = a.id
            WHERE o.order_number = ?
        ");
        $stmt->execute([$order_number]);
        $order = $stmt->fetch();

        if (!$order) {
            json_response('error', 'No order found with ID ' . $order_number, [], 404);
        }

        $items = $pdo->prepare("
            SELECT oi.*, m.brand_name, m.strength
            FROM order_items oi
            JOIN medicines m ON oi.medicine_id = m.id
            WHERE oi.order_id = ?
        ");
        $items->execute([$order['id']]);
        $order['items'] = $items->fetchAll();

        json_response('success', 'Order found', ['order' => $order]);
        break;

    // ---------------------------------------------------------
    // 7. PHARMACY DASHBOARD ENDPOINTS
    // ---------------------------------------------------------
    case 'pharmacy_data':
        require_auth('pharmacy');
        $pstmt = $pdo->prepare("SELECT * FROM pharmacies WHERE user_id = ? LIMIT 1");
        $pstmt->execute([$_SESSION['user_id']]);
        $pharmacy = $pstmt->fetch();
        $pid = (int)$pharmacy['id'];

        $inv = $pdo->prepare("
            SELECT i.*, m.brand_name, m.generic_name, m.strength, m.dosage_form, m.pack_size
            FROM inventory i JOIN medicines m ON i.medicine_id = m.id
            WHERE i.pharmacy_id = ? ORDER BY m.brand_name
        ");
        $inv->execute([$pid]);

        $ords = $pdo->prepare("
            SELECT o.*, u.full_name AS customer_name, u.phone AS customer_phone, rx.file_name AS rx_file
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN prescriptions rx ON rx.order_id = o.id
            WHERE o.pharmacy_id = ? ORDER BY o.created_at DESC
        ");
        $ords->execute([$pid]);

        $catalog = $pdo->query("SELECT id, brand_name, strength, dosage_form FROM medicines ORDER BY brand_name")->fetchAll();

        json_response('success', 'Pharmacy data loaded', [
            'pharmacy'  => $pharmacy,
            'inventory' => $inv->fetchAll(),
            'orders'    => $ords->fetchAll(),
            'catalog'   => $catalog
        ]);
        break;

    case 'pharmacy_save_inventory':
        require_auth('pharmacy');
        $pstmt = $pdo->prepare("SELECT id FROM pharmacies WHERE user_id = ?");
        $pstmt->execute([$_SESSION['user_id']]);
        $pid = (int)$pstmt->fetchColumn();

        $med_id = (int)($_POST['medicine_id'] ?? 0);
        if ($med_id === 0) {
            $ins = $pdo->prepare("INSERT INTO medicines (brand_name, generic_name, active_ingredient, strength, dosage_form, pack_size, category, requires_prescription) VALUES (?, ?, ?, ?, ?, ?, 'General', ?)");
            $ins->execute([
                trim($_POST['brand_name']), trim($_POST['generic_name']), trim($_POST['generic_name']),
                trim($_POST['strength']), $_POST['dosage_form'], trim($_POST['pack_size']), (int)$_POST['requires_prescription']
            ]);
            $med_id = (int)$pdo->lastInsertId();
        }

        $stmt = $pdo->prepare("
            INSERT INTO inventory (pharmacy_id, medicine_id, stock_quantity, price, is_available)
            VALUES (?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE stock_quantity = VALUES(stock_quantity), price = VALUES(price), is_available = 1
        ");
        $stmt->execute([$pid, $med_id, (int)$_POST['stock_quantity'], (float)$_POST['price']]);
        json_response('success', 'Inventory item saved!');
        break;

    case 'pharmacy_update_order':
        require_auth('pharmacy');
        $pstmt = $pdo->prepare("SELECT id FROM pharmacies WHERE user_id = ?");
        $pstmt->execute([$_SESSION['user_id']]);
        $pid = (int)$pstmt->fetchColumn();

        $order_id   = (int)$_POST['order_id'];
        $new_status = $_POST['order_status'] ?? 'Accepted by Pharmacy';
        $pdo->prepare("UPDATE orders SET order_status = ? WHERE id = ? AND pharmacy_id = ?")
            ->execute([$new_status, $order_id, $pid]);
        json_response('success', 'Order updated to ' . $new_status);
        break;

    // ---------------------------------------------------------
    // 8. ADMIN DASHBOARD ENDPOINTS
    // ---------------------------------------------------------
    case 'admin_data':
        require_auth('admin');
        $stats = [
            'customers'  => $pdo->query("SELECT COUNT(*) FROM users WHERE role='customer'")->fetchColumn(),
            'pharmacies' => $pdo->query("SELECT COUNT(*) FROM pharmacies")->fetchColumn(),
            'pending'    => $pdo->query("SELECT COUNT(*) FROM pharmacies WHERE verification_status='pending'")->fetchColumn(),
            'orders'     => $pdo->query("SELECT COUNT(*) FROM orders")->fetchColumn()
        ];
        $pharmacies = $pdo->query("SELECT p.*, u.email FROM pharmacies p JOIN users u ON p.user_id = u.id ORDER BY p.id DESC")->fetchAll();
        $orders     = $pdo->query("SELECT o.*, u.full_name AS customer_name, p.pharmacy_name FROM orders o JOIN users u ON o.user_id=u.id JOIN pharmacies p ON o.pharmacy_id=p.id ORDER BY o.id DESC")->fetchAll();
        $requests   = $pdo->query("SELECT * FROM medicine_requests ORDER BY id DESC")->fetchAll();

        json_response('success', 'Admin data loaded', [
            'stats'      => $stats,
            'pharmacies' => $pharmacies,
            'orders'     => $orders,
            'requests'   => $requests
        ]);
        break;

    case 'admin_verify_pharmacy':
        require_auth('admin');
        $pid    = (int)$_POST['pharmacy_id'];
        $status = in_array($_POST['verification_status'], ['verified', 'pending', 'suspended']) ? $_POST['verification_status'] : 'pending';
        $pdo->prepare("UPDATE pharmacies SET verification_status = ? WHERE id = ?")->execute([$status, $pid]);
        json_response('success', 'Pharmacy status updated to ' . strtoupper($status));
        break;

    default:
        json_response('error', 'Invalid API action.', [], 400);
}