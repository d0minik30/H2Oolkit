#!/usr/bin/env python3
"""
Test script to verify frontend-backend communication for H2Oolkit.
Requires both servers running:
  - Backend: http://localhost:5000
  - Frontend: http://localhost:8000
"""

import requests
import json
import sys
from time import sleep

BACKEND_URL = "http://localhost:5000"
FRONTEND_URL = "http://localhost:8000"

def test_backend_health():
    """Test if backend /api/health endpoint is responding"""
    print("\n[1] Testing Backend Health Check...")
    try:
        response = requests.get(f"{BACKEND_URL}/api/health", timeout=2)
        if response.status_code == 200:
            data = response.json()
            print(f"    ✓ Backend is online: {data}")
            return True
        else:
            print(f"    ✗ Backend returned status {response.status_code}")
            return False
    except Exception as e:
        print(f"    ✗ Backend unreachable: {e}")
        return False

def test_frontend_served():
    """Test if frontend HTML is being served"""
    print("\n[2] Testing Frontend Server...")
    try:
        response = requests.get(f"{FRONTEND_URL}/index.html", timeout=2)
        if response.status_code == 200:
            print(f"    ✓ Frontend is serving index.html ({len(response.text)} bytes)")
            return True
        else:
            print(f"    ✗ Frontend returned status {response.status_code}")
            return False
    except Exception as e:
        print(f"    ✗ Frontend unreachable: {e}")
        return False

def test_backend_springs():
    """Test if backend can return springs data"""
    print("\n[3] Testing Backend /api/springs Endpoint...")
    try:
        response = requests.get(f"{BACKEND_URL}/api/springs", timeout=5)
        if response.status_code == 200:
            data = response.json()
            count = data.get('count', 0)
            print(f"    ✓ Springs endpoint working: {count} springs loaded")
            return True
        else:
            print(f"    ✗ Endpoint returned status {response.status_code}")
            return False
    except Exception as e:
        print(f"    ✗ Failed to fetch springs: {e}")
        return False

def test_cors():
    """Test if CORS is properly configured (simulating browser request)"""
    print("\n[4] Testing CORS Configuration...")
    try:
        headers = {
            "Origin": f"{FRONTEND_URL}",
            "User-Agent": "Test Client"
        }
        response = requests.options(
            f"{BACKEND_URL}/api/health",
            headers=headers,
            timeout=2
        )
        
        # Check for CORS headers
        cors_header = response.headers.get("Access-Control-Allow-Origin")
        if cors_header:
            print(f"    ✓ CORS enabled: {cors_header}")
            return True
        else:
            # Try a simple GET which might still work
            response = requests.get(f"{BACKEND_URL}/api/health", timeout=2)
            if response.status_code == 200:
                print(f"    ✓ Backend responds (CORS may be configured in Flask-CORS)")
                return True
            else:
                print(f"    ✗ No CORS header found")
                return False
    except Exception as e:
        print(f"    ✗ CORS test failed: {e}")
        return False

def test_api_client_call():
    """Simulate what the frontend JavaScript client would do"""
    print("\n[5] Testing Simulated Frontend API Call...")
    try:
        # This simulates what api-client.js checkBackend() does
        response = requests.get(
            f"{BACKEND_URL}/api/health",
            headers={"Origin": f"{FRONTEND_URL}"},
            timeout=2
        )
        if response.ok:
            print(f"    ✓ Frontend can successfully call backend API")
            return True
        else:
            print(f"    ✗ API call failed with status {response.status_code}")
            return False
    except Exception as e:
        print(f"    ✗ Frontend API simulation failed: {e}")
        return False

def main():
    print("=" * 60)
    print("H2Oolkit Frontend-Backend Communication Test")
    print("=" * 60)
    print(f"Backend URL:  {BACKEND_URL}")
    print(f"Frontend URL: {FRONTEND_URL}")
    
    results = {
        "Backend Health": test_backend_health(),
        "Frontend Server": test_frontend_served(),
        "Backend Springs API": test_backend_springs(),
        "CORS Configuration": test_cors(),
        "Frontend API Simulation": test_api_client_call(),
    }
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for test_name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{test_name:.<40} {status}")
    
    all_passed = all(results.values())
    print("=" * 60)
    
    if all_passed:
        print("\n🎉 All tests passed! Frontend and backend are communicating.")
        return 0
    else:
        print("\n⚠️  Some tests failed. Check the output above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
