<?php
/**
 * ============================================================================
 * OrbitAvanya Email Tracking Script
 * Deploy this file to: /home/avanyate/track.orbitavanyatech.com/index.php
 * ============================================================================
 * This script handles:
 *   /track   → Email open tracking (pixel)
 *   /click   → Link click tracking + redirect to website
 *   /visit   → Website visit tracking page
 *   /locate  → Location beacon
 *   /status  → Health check
 * ============================================================================
 */

// ── CONFIG — UPDATE THESE ──────────────────────────────────────────────────
$LOG_FILE   = __DIR__ . "/tracking_log.json";   // stores all tracking events
$SECRET_KEY = "orbitavanya2026";                 // optional security key

// ── CORS headers (allow your email clients to load pixel) ─────────────────
header("Access-Control-Allow-Origin: *");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");

// ── Route detection ────────────────────────────────────────────────────────
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = rtrim($path, '/');

// Get client real IP (works behind Cloudflare proxy too)
function get_real_ip() {
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP']))
        return $_SERVER['HTTP_CF_CONNECTING_IP'];
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR']))
        return explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0];
    return $_SERVER['REMOTE_ADDR'] ?? '';
}

// Get location from IP using ip-api.com (free)
function get_location($ip) {
    if (empty($ip) || $ip === '127.0.0.1') return [];
    $url  = "http://ip-api.com/json/{$ip}?fields=status,country,city,timezone,regionName";
    $data = @json_decode(@file_get_contents($url), true);
    if ($data && $data['status'] === 'success') {
        return [
            'country'  => $data['country']    ?? '',
            'city'     => $data['city']       ?? '',
            'region'   => $data['regionName'] ?? '',
            'timezone' => $data['timezone']   ?? '',
        ];
    }
    return [];
}

// Save tracking event to log file
function save_event($type, $email, $company, $extra = []) {
    global $LOG_FILE;
    $events = [];
    if (file_exists($LOG_FILE)) {
        $events = json_decode(file_get_contents($LOG_FILE), true) ?? [];
    }
    $event = array_merge([
        'type'      => $type,
        'email'     => $email,
        'company'   => $company,
        'timestamp' => date('d-m-Y H:i:s'),
        'ip'        => get_real_ip(),
    ], $extra);

    $events[] = $event;
    file_put_contents($LOG_FILE, json_encode($events, JSON_PRETTY_PRINT));
}

// Tiny 1x1 transparent GIF
function send_pixel() {
    header("Content-Type: image/gif");
    echo base64_decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    exit;
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

// /track — Email open pixel
if ($path === '/track' || $path === '') {
    $email   = trim($_GET['email']   ?? '');
    $company = trim($_GET['company'] ?? '');
    if ($email) {
        $ip  = get_real_ip();
        save_event('open', $email, $company, ['ip' => $ip]);
    }
    send_pixel();
}

// /click — Link click tracking + redirect to visit page
elseif ($path === '/click') {
    $email   = trim($_GET['email']   ?? '');
    $company = trim($_GET['company'] ?? '');
    $dest    = trim($_GET['dest']    ?? 'https://orbitavanyatech.com');
    $ip      = get_real_ip();
    $loc     = get_location($ip);

    if ($email) {
        save_event('click', $email, $company, array_merge(['dest' => $dest], $loc));
    }

    // Redirect to visit tracking page
    $visit_url = "https://track.orbitavanyatech.com/visit"
               . "?email=" . urlencode($email)
               . "&company=" . urlencode($company)
               . "&dest=" . urlencode($dest);
    header("Location: $visit_url", true, 302);
    exit;
}

// /visit — Visit tracking page (tracks time on site)
elseif ($path === '/visit') {
    $email   = htmlspecialchars(trim($_GET['email']   ?? ''));
    $company = htmlspecialchars(trim($_GET['company'] ?? ''));
    $dest    = htmlspecialchars(trim($_GET['dest']    ?? 'https://orbitavanyatech.com'));
    $ip      = get_real_ip();
    $loc     = get_location($ip);

    if ($email) {
        save_event('visit_start', $email, $company, $loc);
    }

    header("Content-Type: text/html; charset=utf-8");
    echo <<<HTML
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>OrbitAvanya Tech LLP</title>
<style>
body{margin:0;display:flex;align-items:center;justify-content:center;
     height:100vh;font-family:Arial,sans-serif;background:#EAF3FB;}
.box{text-align:center;color:#062E56;}
.logo{font-size:22px;font-weight:bold;margin-bottom:8px;}
.sub{font-size:13px;color:#0D5A9E;}
</style>
<script>
var startTime = Date.now();
function sendTime(){
  var spent = Math.round((Date.now()-startTime)/1000);
  navigator.sendBeacon(
    "https://track.orbitavanyatech.com/visit-end"
    + "?email=" + encodeURIComponent("$email")
    + "&company=" + encodeURIComponent("$company")
    + "&seconds=" + spent
  );
}
window.addEventListener("beforeunload", sendTime);
setTimeout(function(){ window.location.href = "$dest"; }, 1500);
</script>
</head>
<body>
  <div class="box">
    <div class="logo">OrbitAvanya Tech LLP</div>
    <div class="sub">Taking you to our website...</div>
  </div>
</body>
</html>
HTML;
    exit;
}

// /visit-end — Time spent beacon
elseif ($path === '/visit-end') {
    $email   = trim($_GET['email']   ?? '');
    $company = trim($_GET['company'] ?? '');
    $seconds = intval($_GET['seconds'] ?? 0);
    if ($email && $seconds > 0) {
        save_event('visit_end', $email, $company, ['seconds' => $seconds]);
    }
    http_response_code(204);
    exit;
}

// /locate — Location beacon from "view in browser" link
elseif ($path === '/locate') {
    $email   = trim($_GET['email']   ?? '');
    $company = trim($_GET['company'] ?? '');
    $ip      = get_real_ip();
    $loc     = get_location($ip);
    if ($email) {
        save_event('locate', $email, $company, $loc);
    }
    header("Location: https://orbitavanyatech.com", true, 302);
    exit;
}

// /events — View all tracking events (for debugging)
elseif ($path === '/events') {
    $key = trim($_GET['key'] ?? '');
    if ($key !== $SECRET_KEY) {
        http_response_code(403);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }
    header("Content-Type: application/json");
    echo file_exists($LOG_FILE) ? file_get_contents($LOG_FILE) : '[]';
    exit;
}

// /status — Health check
elseif ($path === '/status') {
    header("Content-Type: application/json");
    echo json_encode(['status' => 'running', 'domain' => 'track.orbitavanyatech.com']);
    exit;
}

// 404
else {
    http_response_code(404);
    echo "Not found";
    exit;
}
?>
