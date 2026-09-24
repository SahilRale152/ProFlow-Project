<?php
// OrbitAvanya Email Tracking Script
// Upload this file to cPanel File Manager at: public_html/track.php

$LOG_FILE   = __DIR__ . "/tracking_log.json";
$SECRET_KEY = "orbitavanya2026";

header("Access-Control-Allow-Origin: *");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");

$action = trim($_GET['action'] ?? '');
$email   = trim($_GET['email']   ?? '');
$company = trim($_GET['company'] ?? '');
$dest    = trim($_GET['dest']    ?? 'https://orbitavanyatech.com');
$page    = trim($_GET['page']    ?? 'Website');

function get_real_ip() {
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) return $_SERVER['HTTP_CF_CONNECTING_IP'];
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) return explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0];
    return $_SERVER['REMOTE_ADDR'] ?? '';
}

function get_location($ip) {
    if (empty($ip) || $ip === '127.0.0.1') return [];
    $url  = "http://ip-api.com/json/{$ip}?fields=status,country,city,timezone,regionName";
    $data = @json_decode(@file_get_contents($url), true);
    if ($data && $data['status'] === 'success') {
        return ['country' => $data['country']??'', 'city' => $data['city']??'', 'timezone' => $data['timezone']??''];
    }
    return [];
}

function save_event($type, $email, $company, $extra = []) {
    global $LOG_FILE;
    $events = file_exists($LOG_FILE) ? (json_decode(file_get_contents($LOG_FILE), true) ?? []) : [];
    $events[] = array_merge(['type'=>$type,'email'=>$email,'company'=>$company,'timestamp'=>date('d-m-Y H:i:s')], $extra);
    file_put_contents($LOG_FILE, json_encode($events, JSON_PRETTY_PRINT));
}

function send_pixel() {
    header("Content-Type: image/gif");
    echo base64_decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    exit;
}

// ── ROUTES ──
if ($action === 'track') {
    if ($email) save_event('open', $email, $company, ['ip'=>get_real_ip()]);
    send_pixel();
}
elseif ($action === 'click') {
    $ip = get_real_ip(); $loc = get_location($ip);
    if ($email) save_event('click', $email, $company, array_merge(['dest'=>$dest, 'page'=>$page], $loc));
    $base = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? "https" : "http") . "://$_SERVER[HTTP_HOST]";
    $visit_url = "$base/" . basename($_SERVER['SCRIPT_NAME']) . "?action=visit&email=" . urlencode($email) . "&company=" . urlencode($company) . "&dest=" . urlencode($dest) . "&page=" . urlencode($page);
    header("Location: $visit_url", true, 302);
    exit;
}
elseif ($action === 'visit') {
    $ip = get_real_ip(); $loc = get_location($ip);
    if ($email) save_event('visit_start', $email, $company, array_merge(['page'=>$page], $loc));
    $safe_page = htmlspecialchars($page);
    echo "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>OrbitAvanya Tech LLP</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial,sans-serif;background:#EAF3FB;}.box{text-align:center;color:#062E56;}.logo{font-size:22px;font-weight:bold;}</style><script>
var st=Date.now(); function send(){var s=Math.round((Date.now()-st)/1000); if(s>0)navigator.sendBeacon('" . $_SERVER['SCRIPT_NAME'] . "?action=visit-end&email=" . urlencode($email) . "&company=" . urlencode($company) . "&seconds='+s+'&page=" . urlencode($page) . "');}
window.addEventListener('beforeunload',send); window.addEventListener('pagehide',send);
setTimeout(function(){window.location.href='" . htmlspecialchars($dest, ENT_QUOTES) . "';},1500);
</script></head><body><div class='box'><div class='logo'>OrbitAvanya Tech LLP</div><div class='sub'>Taking you to our website...</div></div></body></html>";
    exit;
}
elseif ($action === 'visit-end') {
    $seconds = intval($_GET['seconds'] ?? 0);
    if ($email && $seconds > 0) save_event('visit_end', $email, $company, ['seconds'=>$seconds, 'page'=>$page]);
    http_response_code(204);
    exit;
}
elseif ($action === 'locate') {
    $ip = get_real_ip(); $loc = get_location($ip);
    if ($email) save_event('locate', $email, $company, $loc);
    header("Location: https://orbitavanyatech.com", true, 302);
    exit;
}
elseif ($action === 'events') {
    $key = trim($_GET['key'] ?? '');
    if ($key !== $SECRET_KEY) { http_response_code(403); echo json_encode(['error'=>'Unauthorized']); exit; }
    header("Content-Type: application/json");
    echo file_exists($LOG_FILE) ? file_get_contents($LOG_FILE) : '[]';
    exit;
}
elseif ($action === 'status') {
    header("Content-Type: application/json");
    echo json_encode(['status'=>'running']);
    exit;
}
else {
    http_response_code(404);
    echo "Not found";
    exit;
}
