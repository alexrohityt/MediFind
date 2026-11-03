<?php
// File: api/db.php
header('Content-Type: application/json; charset=utf-8');

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

$host = '127.0.0.1';
$db   = 'medifind_db';
$user = 'root';
$pass = ''; // Default XAMPP password is empty

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'Database connection failed. Ensure medifind_db is imported.']);
    exit;
}

function json_response(string $status, string $message, array $data = [], int $code = 200): void {
    http_response_code($code);
    echo json_encode(array_merge(['status' => $status, 'message' => $message], $data));
    exit;
}

function require_auth(?string $role = null): void {
    if (empty($_SESSION['user_id'])) {
        json_response('error', 'Authentication required. Please log in.', [], 401);
    }
    if ($role !== null && ($_SESSION['role'] ?? '') !== $role) {
        json_response('error', 'Unauthorized access for your account role.', [], 403);
    }
}