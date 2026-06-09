#!/usr/bin/env python3
"""End-to-end API test — runs from the server machine's terminal."""

import http.client, json, time, sys

BASE = "127.0.0.1"
PORT = 8000

def get(path):
    conn = http.client.HTTPConnection(BASE, PORT, timeout=8)
    conn.request("GET", path)
    r = conn.getresponse()
    return r.status, json.loads(r.read())

def post_json(path, body):
    data = json.dumps(body).encode()
    conn = http.client.HTTPConnection(BASE, PORT, timeout=8)
    conn.request("POST", path, data, {"Content-Type": "application/json"})
    r = conn.getresponse()
    return r.status, json.loads(r.read())

def post_file(path, filename, file_bytes):
    boundary = "TestBoundary999"
    body = (
        ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode()
        + file_bytes
        + ("\r\n--" + boundary + "--\r\n").encode()
    )
    conn = http.client.HTTPConnection(BASE, PORT, timeout=30)
    conn.request("POST", path, body, {"Content-Type": "multipart/form-data; boundary=" + boundary})
    r = conn.getresponse()
    return r.status, json.loads(r.read())

ok = 0
fail = 0

def check(name, status, data, expected_status=200):
    global ok, fail
    passed = status == expected_status
    icon = "✅" if passed else "❌"
    print(f"{icon} [{status}] {name}")
    if not passed:
        print(f"   → {data}")
        fail += 1
    else:
        ok += 1
    return data

# 1. Health
s, d = get("/health")
check("GET /health", s, d)

# 2. Models
s, d = get("/models")
check("GET /models", s, d)
print(f"   → {d['total']} known models")

# 3. Jobs (empty at start)
s, d = get("/jobs")
check("GET /jobs", s, d)

# 4. Upload .pth file
fake_pth = b"\x80\x02}q\x00." + b"\x00" * 512
s, d = post_file("/fingerprint/upload", "test.pth", fake_pth)
check("POST /fingerprint/upload (.pth)", s, d)
if s == 200:
    job_id = d["job_id"]
    print(f"   → job_id: {job_id}")
    print(f"   → s3_key: {d.get('s3_key')}")

    # 5. Poll job
    time.sleep(1)
    s2, d2 = get(f"/job/{job_id}")
    check(f"GET /job/{job_id}", s2, d2)
    print(f"   → status: {d2['status']}")

# 6. API fingerprint job
s, d = post_json("/fingerprint/api", {
    "api_endpoint": "https://api.anthropic.com",
    "api_key": "test-key-placeholder",
    "model_name": "claude-test"
})
check("POST /fingerprint/api", s, d)
if s == 200:
    print(f"   → job_id: {d['job_id']}")

# 7. 404 for unknown job
s, d = get("/job/nonexistent-job-id")
check("GET /job/<invalid> → 404", s, d, expected_status=404)

print(f"\n{'='*40}")
print(f"Results: {ok} passed, {fail} failed")
sys.exit(0 if fail == 0 else 1)
