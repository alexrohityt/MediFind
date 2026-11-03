// File: assets/js/app.js
// Vanilla JavaScript Frontend Engine communicating with api/api.php via fetch()

let cart = JSON.parse(localStorage.getItem('medifind_cart') || '[]');
let currentUser = null;
let selectedCategory = '';

document.addEventListener('DOMContentLoaded', async () => {
    await checkSession();
    updateCartBadge();

    // Route initializer based on active HTML page
    if (document.getElementById('resultsContainer')) {
        loadMedicines();
        setupCustomerPage();
    }
    if (document.getElementById('loginForm')) {
        setupAuthPage();
    }
    if (document.getElementById('pharmInventoryBody')) {
        loadPharmacyDashboard();
    }
    if (document.getElementById('adminPharmaciesBody')) {
        loadAdminDashboard();
    }
});

// 1. Check Logged-in User Session
async function checkSession() {
    try {
        const res = await fetch('api/api.php?action=session');
        const data = await res.json();
        currentUser = data.user || null;

        const navArea = document.getElementById('authNavArea');
        if (navArea && currentUser) {
            let dashLink = '';
            if (currentUser.role === 'pharmacy') dashLink = `<a href="pharmacy.html" class="btn btn-outline">Pharmacy Panel</a>`;
            if (currentUser.role === 'admin') dashLink = `<a href="admin.html" class="btn btn-outline">Admin Panel</a>`;
            navArea.innerHTML = `
                ${dashLink}
                <span style="font-weight:600;">Hi, ${escapeHtml(currentUser.full_name)}</span>
                <button class="btn btn-danger-outline btn-sm" onclick="logoutUser()">Logout</button>
            `;
        }
    } catch (e) {
        console.error('Session check error:', e);
    }
}

async function logoutUser() {
    await fetch('api/api.php?action=logout');
    window.location.href = 'login.html';
}

// 2. Customer Search, Geolocation & Request Form
function setupCustomerPage() {
    document.getElementById('searchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        selectedCategory = '';
        updateCategoryButtons();
        loadMedicines();
    });

    document.getElementById('searchSort').addEventListener('change', () => loadMedicines());
    document.getElementById('searchQuery').addEventListener('input', () => {
        if (selectedCategory) {
            selectedCategory = '';
            updateCategoryButtons();
        }
    });

    // GPS Button
    const gpsBtn = document.getElementById('gpsBtn');
    const gpsStatus = document.getElementById('gpsStatus');
    gpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            gpsStatus.textContent = 'Geolocation is not supported by your browser.';
            return;
        }
        gpsStatus.textContent = 'Detecting your location...';
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
                const d = await r.json();
                const pin = d.address?.postcode || d.address?.city || '';
                document.getElementById('searchLocation').value = pin;
                gpsStatus.textContent = `Location set to: ${pin || latitude.toFixed(4)}`;
                loadMedicines();
            } catch {
                gpsStatus.textContent = `Coordinates captured.`;
            }
        }, () => {
            gpsStatus.textContent = 'Permission denied. Enter PIN code manually.';
        });
    });

    // Checkout Form Submit
    document.getElementById('checkoutForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) {
            alert('Please login as a Customer before placing an order.');
            window.location.href = 'login.html';
            return;
        }
        const formData = new FormData(e.target);
        formData.append('action', 'place_order');
        formData.append('cart', JSON.stringify(cart));

        const res = await fetch('api/api.php', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.status === 'success') {
            cart = [];
            saveCart();
            toggleCartModal();
            showAlert(`Order Confirmed! Your Unique Order ID is: ${data.order_number}`, 'success');
            document.getElementById('trackOrderInput').value = data.order_number;
            trackOrderById(data.order_number);
            loadMedicines();
        } else {
            alert(data.message);
        }
    });

    // Order Tracker Form
    document.getElementById('trackOrderForm').addEventListener('submit', (e) => {
        e.preventDefault();
        trackOrderById(document.getElementById('trackOrderInput').value.trim());
    });
}

function quickFilter(term) {
    selectedCategory = selectedCategory === term ? '' : term;
    document.getElementById('searchQuery').value = '';
    updateCategoryButtons();
    loadMedicines().then(() => document.getElementById('search-section')?.scrollIntoView({ behavior: 'smooth' }));
}

function updateCategoryButtons() {
    document.querySelectorAll('.category-card[data-category]').forEach((button) => {
        const selected = button.dataset.category === selectedCategory;
        button.classList.toggle('category-card-active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
}

async function loadMedicines() {
    const q = document.getElementById('searchQuery')?.value || '';
    const location = document.getElementById('searchLocation')?.value || '';
    const sort = document.getElementById('searchSort')?.value || 'price_asc';

    const container = document.getElementById('resultsContainer');
    const params = new URLSearchParams({ action: 'search_medicines', q, location, sort });
    if (selectedCategory) params.set('category', selectedCategory);

    try {
        const res = await fetch(`api/api.php?${params}`);
        const responseText = await res.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            if (responseText.trimStart().startsWith('<?php')) {
                throw new Error('PHP is being served as text instead of running. Double-click start-medifind.bat in the MediFind folder, then open http://127.0.0.1:8095/index.html.');
            }
            throw new Error(`The search API returned an invalid response (HTTP ${res.status}). Start MediFind with start-medifind.bat and make sure MySQL is running.`);
        }
        if (!res.ok || data.status === 'error') {
            throw new Error(data.message || 'Medicine search could not be completed.');
        }

        if (!data.results || data.results.length === 0) {
            container.innerHTML = `
            <div class="card" style="grid-column: 1 / -1;">
                <h3>${selectedCategory ? `${escapeHtml(selectedCategory)} medicines are not available` : 'Medicine not found in the selected area.'}</h3>
                <p>Submit a Medicine Availability Request and nearby verified pharmacies will be alerted:</p>
                <form onsubmit="submitMedicineRequest(event)" style="margin-top:1rem;">
                    <div class="form-row">
                        <input type="text" name="customer_name" placeholder="Your Name *" required>
                        <input type="text" name="customer_phone" placeholder="Mobile Number *" required>
                    </div>
                    <div class="form-row">
                        <input type="text" name="medicine_name" value="${escapeHtml(q)}" placeholder="Medicine Name *" required>
                        <input type="text" name="strength_form" placeholder="Strength/Form (e.g. 500mg Tablet)">
                        <input type="text" name="pincode" value="${escapeHtml(location || '400001')}" placeholder="PIN Code *" required>
                    </div>
                    <button type="submit" class="btn btn-primary">Request Medicine Availability</button>
                </form>
            </div>
        `;
            return;
        }

        container.innerHTML = data.results.map(item => `
        <div class="card">
            <div class="card-header-row">
                <div>
                    <span class="dosage-tag">${escapeHtml(item.dosage_form)} • ${escapeHtml(item.strength)}</span>
                    <h3>${escapeHtml(item.brand_name)}</h3>
                    <small>${escapeHtml(item.generic_name)} (${escapeHtml(item.pack_size)})</small>
                </div>
                <div class="price-tag">₹${Number(item.price).toFixed(2)}</div>
            </div>
            <div>
                ${Number(item.requires_prescription) === 1
                    ? '<span class="rx-badge"><i class="fa-solid fa-file-prescription"></i> Prescription Required</span>'
                    : '<span class="otc-badge">OTC Medicine</span>'}
            </div>
            <hr style="margin:0.8rem 0; border-color:#e2e8f0;">
            <p><strong><i class="fa-solid fa-store"></i> ${escapeHtml(item.pharmacy_name)}</strong></p>
            <p style="font-size:0.85rem; color:#64748b;">${escapeHtml(item.address)}, ${escapeHtml(item.city)} - ${escapeHtml(item.pincode)}</p>
            <p style="font-size:0.85rem; margin-top:0.4rem;">
                <strong style="color:#16a34a;">Stock: ${item.stock_quantity} packs</strong> •
                ~${item.estimated_delivery_mins} mins • Delivery: ₹${Number(item.delivery_charge).toFixed(2)}
            </p>
            <button class="btn btn-primary btn-block" style="margin-top:0.8rem;"
                onclick='addToCart(${JSON.stringify(item)})'>
                <i class="fa-solid fa-cart-plus"></i> Add to Cart
            </button>
        </div>
    `).join('');
    } catch (error) {
        container.innerHTML = `<div class="card alert alert-danger" style="grid-column:1 / -1;" role="alert">${escapeHtml(error.message)} Start the MediFind PHP server and make sure its database is available, then try again.</div>`;
    }
}

async function submitMedicineRequest(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.append('action', 'request_medicine');
    const res = await fetch('api/api.php', { method: 'POST', body: fd });
    const data = await res.json();
    showAlert(data.message, 'success');
    e.target.reset();
}

// 3. Cart Management
function addToCart(item) {
    if (cart.length > 0 && cart[0].pharmacy_id !== item.pharmacy_id) {
        if (!confirm('Your cart contains items from another pharmacy. Clear cart and switch to ' + item.pharmacy_name + '?')) {
            return;
        }
        cart = [];
    }
    const existing = cart.find(c => c.inventory_id === item.inventory_id);
    if (existing) {
        if (existing.quantity < item.stock_quantity) existing.quantity++;
    } else {
        cart.push({
            inventory_id: item.inventory_id,
            pharmacy_id: item.pharmacy_id,
            pharmacy_name: item.pharmacy_name,
            brand_name: item.brand_name,
            price: Number(item.price),
            delivery_charge: Number(item.delivery_charge),
            requires_prescription: Number(item.requires_prescription),
            stock_quantity: Number(item.stock_quantity),
            quantity: 1
        });
    }
    saveCart();
    toggleCartModal(true);
}

function saveCart() {
    localStorage.setItem('medifind_cart', JSON.stringify(cart));
    updateCartBadge();
}

function updateCartBadge() {
    const el = document.getElementById('cartCount');
    if (el) el.textContent = cart.reduce((sum, i) => sum + i.quantity, 0);
}

function toggleCartModal(forceOpen = false) {
    const modal = document.getElementById('cartModal');
    if (!modal) return;
    modal.style.display = (forceOpen || modal.style.display === 'none') ? 'flex' : 'none';
    renderCartModal();
}

function renderCartModal() {
    const box = document.getElementById('cartItemsContainer');
    const form = document.getElementById('checkoutForm');
    if (cart.length === 0) {
        box.innerHTML = `<p style="margin:1rem 0;">Your medicine cart is empty.</p>`;
        form.style.display = 'none';
        return;
    }
    form.style.display = 'block';
    let subtotal = 0;
    const delivery = cart[0].delivery_charge;
    let rows = cart.map((c, idx) => {
        const line = c.price * c.quantity;
        subtotal += line;
        return `
            <tr>
                <td>${escapeHtml(c.brand_name)} ${c.requires_prescription ? '<span class="rx-badge">Rx</span>' : ''}</td>
                <td>₹${c.price.toFixed(2)}</td>
                <td>
                    <input type="number" min="1" max="${c.stock_quantity}" value="${c.quantity}" style="width:60px;"
                        onchange="updateCartQty(${idx}, this.value)">
                </td>
                <td>₹${line.toFixed(2)}</td>
                <td><button class="btn btn-danger-outline btn-sm" onclick="removeCartItem(${idx})">✕</button></td>
            </tr>
        `;
    }).join('');

    box.innerHTML = `
        <p style="margin-top:0.5rem;">Pharmacy: <strong>${escapeHtml(cart[0].pharmacy_name)}</strong></p>
        <table class="data-table">
            <thead><tr><th>Medicine</th><th>Price</th><th>Qty</th><th>Subtotal</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <div style="text-align:right; margin-top:1rem;">
            <p>Subtotal: <strong>₹${subtotal.toFixed(2)}</strong> | Delivery: <strong>₹${delivery.toFixed(2)}</strong></p>
            <h3>Total Payable: ₹${(subtotal + delivery).toFixed(2)}</h3>
        </div>
    `;
}

function updateCartQty(idx, val) {
    cart[idx].quantity = Math.max(1, parseInt(val) || 1);
    saveCart();
    renderCartModal();
}

function removeCartItem(idx) {
    cart.splice(idx, 1);
    saveCart();
    renderCartModal();
}

// 4. Track Order
async function trackOrderById(orderNumber) {
    const box = document.getElementById('trackResultBox');
    const res = await fetch(`api/api.php?action=track_order&order_number=${encodeURIComponent(orderNumber)}`);
    const data = await res.json();
    if (data.status !== 'success') {
        box.innerHTML = `<div class="alert alert-danger">${escapeHtml(data.message)}</div>`;
        return;
    }
    const o = data.order;
    const itemsList = o.items.map(i => `<li>${escapeHtml(i.brand_name)} (${escapeHtml(i.strength)}) × ${i.quantity} — ₹${Number(i.line_total).toFixed(2)}</li>`).join('');
    box.innerHTML = `
        <div class="card" style="background:#f8fafc;">
            <div class="card-header-row">
                <h3>Order #${escapeHtml(o.order_number)}</h3>
                <span class="status-badge">${escapeHtml(o.order_status)}</span>
            </div>
            <p>Pharmacy: <strong>${escapeHtml(o.pharmacy_name)}</strong> | Total: <strong>₹${Number(o.total_amount).toFixed(2)}</strong> (${escapeHtml(o.payment_method)})</p>
            <ul style="margin:0.6rem 0 0 1.2rem;">${itemsList}</ul>
        </div>
    `;
}

// 5. Login & Registration Page
function setupAuthPage() {
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        fd.append('action', 'login');
        const res = await fetch('api/api.php', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.status === 'success') {
            if (data.role === 'pharmacy') window.location.href = 'pharmacy.html';
            else if (data.role === 'admin') window.location.href = 'admin.html';
            else window.location.href = 'index.html';
        } else {
            document.getElementById('authAlert').innerHTML = `<div class="alert alert-danger">${escapeHtml(data.message)}</div>`;
        }
    });

    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        fd.append('action', 'register');
        const res = await fetch('api/api.php', { method: 'POST', body: fd });
        const data = await res.json();
        document.getElementById('authAlert').innerHTML = `<div class="alert ${data.status==='success'?'alert-success':'alert-danger'}">${escapeHtml(data.message)}</div>`;
        if (data.status === 'success') e.target.reset();
    });
}

// 6. Pharmacy Dashboard
async function loadPharmacyDashboard() {
    const res = await fetch('api/api.php?action=pharmacy_data');
    const data = await res.json();
    if (data.status !== 'success') {
        window.location.href = 'login.html';
        return;
    }

    document.getElementById('pharmHeader').innerHTML = `
        <h2>${escapeHtml(data.pharmacy.pharmacy_name)}</h2>
        <p>License: <code>${escapeHtml(data.pharmacy.license_number)}</code> | Verification Status: <span class="status-badge">${escapeHtml(data.pharmacy.verification_status.toUpperCase())}</span></p>
    `;

    document.getElementById('pharmInventoryBody').innerHTML = data.inventory.map(i => `
        <tr>
            <td><strong>${escapeHtml(i.brand_name)}</strong> (${escapeHtml(i.strength)})</td>
            <td>₹${Number(i.price).toFixed(2)}</td>
            <td>${i.stock_quantity} packs</td>
        </tr>
    `).join('');

    const sel = document.getElementById('catalogSelect');
    sel.innerHTML = data.catalog.map(c => `<option value="${c.id}">${escapeHtml(c.brand_name)} (${escapeHtml(c.strength)} ${escapeHtml(c.dosage_form)})</option>`).join('')
        + `<option value="0">+ Create New Medicine in Catalog</option>`;

    const statuses = ['Order Placed','Prescription Verification Pending','Accepted by Pharmacy','Preparing Order','Out for Delivery','Delivered','Cancelled'];
    document.getElementById('pharmOrdersBody').innerHTML = data.orders.map(o => `
        <tr>
            <td><strong>${escapeHtml(o.order_number)}</strong></td>
            <td>${escapeHtml(o.customer_name)} (${escapeHtml(o.customer_phone)})</td>
            <td>₹${Number(o.total_amount).toFixed(2)}</td>
            <td>${o.rx_file ? `<a href="uploads/prescriptions/${encodeURIComponent(o.rx_file)}" target="_blank">View Rx</a>` : 'OTC'}</td>
            <td><span class="status-badge">${escapeHtml(o.order_status)}</span></td>
            <td>
                <select onchange="updateOrderStatus(${o.id}, this.value)">
                    ${statuses.map(s => `<option value="${s}" ${o.order_status===s?'selected':''}>${s}</option>`).join('')}
                </select>
            </td>
        </tr>
    `).join('');

    document.getElementById('addInventoryForm').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        fd.append('action', 'pharmacy_save_inventory');
        await fetch('api/api.php', { method: 'POST', body: fd });
        loadPharmacyDashboard();
    };
}

async function updateOrderStatus(orderId, status) {
    const fd = new FormData();
    fd.append('action', 'pharmacy_update_order');
    fd.append('order_id', orderId);
    fd.append('order_status', status);
    await fetch('api/api.php', { method: 'POST', body: fd });
    loadPharmacyDashboard();
}

// 7. Admin Dashboard
async function loadAdminDashboard() {
    const res = await fetch('api/api.php?action=admin_data');
    const data = await res.json();
    if (data.status !== 'success') {
        window.location.href = 'login.html';
        return;
    }

    document.getElementById('adminStatsGrid').innerHTML = `
        <div class="stat-card"><h3>${data.stats.customers}</h3><p>Total Customers</p></div>
        <div class="stat-card"><h3>${data.stats.pharmacies}</h3><p>Registered Pharmacies</p></div>
        <div class="stat-card"><h3>${data.stats.pending}</h3><p>Pending Verifications</p></div>
        <div class="stat-card"><h3>${data.stats.orders}</h3><p>Total Platform Orders</p></div>
    `;

    document.getElementById('adminPharmaciesBody').innerHTML = data.pharmacies.map(p => `
        <tr>
            <td><strong>${escapeHtml(p.pharmacy_name)}</strong><br><small>${escapeHtml(p.email)}</small></td>
            <td><code>${escapeHtml(p.license_number)}</code></td>
            <td>${escapeHtml(p.city)} - ${escapeHtml(p.pincode)}</td>
            <td><span class="status-badge">${escapeHtml(p.verification_status.toUpperCase())}</span></td>
            <td>
                <select onchange="verifyPharmacy(${p.id}, this.value)">
                    <option value="verified" ${p.verification_status==='verified'?'selected':''}>Verified</option>
                    <option value="pending" ${p.verification_status==='pending'?'selected':''}>Pending</option>
                    <option value="suspended" ${p.verification_status==='suspended'?'selected':''}>Suspended</option>
                </select>
            </td>
        </tr>
    `).join('');

    document.getElementById('adminRequestsBody').innerHTML = data.requests.map(r => `
        <tr>
            <td>${escapeHtml(r.customer_name)}</td>
            <td>${escapeHtml(r.customer_phone)}</td>
            <td><strong>${escapeHtml(r.medicine_name)}</strong> (${escapeHtml(r.strength_form || '')})</td>
            <td>${escapeHtml(r.pincode)}</td>
            <td>${escapeHtml(r.created_at)}</td>
        </tr>
    `).join('');
}

async function verifyPharmacy(pharmacyId, status) {
    const fd = new FormData();
    fd.append('action', 'admin_verify_pharmacy');
    fd.append('pharmacy_id', pharmacyId);
    fd.append('verification_status', status);
    await fetch('api/api.php', { method: 'POST', body: fd });
    loadAdminDashboard();
}

function showAlert(msg, type = 'success') {
    const box = document.getElementById('alertBox');
    if (box) box.innerHTML = `<div class="alert alert-${type}">${escapeHtml(msg)}</div>`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}