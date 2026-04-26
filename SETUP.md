# H2Oolkit - Setup Guide

## **Quick Start (New Device)**

### **Windows**
1. **Download & Extract** the project
2. **Double-click** `setup.bat` → wait for completion
3. **Double-click** `run_backend.bat` → leave it open
4. **Double-click** `run_frontend.bat` (in another window)
5. Open **http://localhost:8000** in browser ✓

### **Mac/Linux**
```bash
# 1. Create virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install dependencies
pip install -r backend/requirements.txt

# 3. Run backend (Terminal 1)
python -m backend.server

# 4. Run frontend (Terminal 2)
python -m http.server 8000
```

---

## **Detailed Setup Steps**

### **1. System Requirements**
- **Python 3.9+** (download from https://www.python.org)
  - ⚠️ **Windows**: Check "Add Python to PATH" during installation
- **Git** (optional, for cloning the repo)
- **Modern web browser** (Chrome, Firefox, Edge, Safari)

### **2. Clone or Download Repository**
```bash
# Option A: Clone with Git
git clone <repo-url>
cd H2Oolkit

# Option B: Download ZIP and extract
# Then navigate to the folder
```

### **3. Create Virtual Environment**

**Windows:**
```bash
python -m venv venv
venv\Scripts\activate
```

**Mac/Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
```

Your prompt should now show `(venv)` at the beginning.

### **4. Install Dependencies**
```bash
# Upgrade pip first
python -m pip install --upgrade pip

# Install all requirements
pip install -r backend/requirements.txt
```

**Required packages:**
- `flask` >= 3.0 — Web framework
- `flask-cors` >= 4.0 — Cross-origin requests
- `requests` >= 2.31 — HTTP library
- `numpy` >= 1.24 — Numerical computing
- `earthengine-api` >= 0.1.380 — Satellite data
- `reportlab` >= 4.0 — PDF generation

### **5. Run the Application**

**Backend** (API server on port 5000):
```bash
python -m backend.server
```

**Frontend** (Web server on port 8000):
```bash
python -m http.server 8000
```

Open in browser: **http://localhost:8000**

---

## **Troubleshooting**

### **"python: command not found"**
- Python not installed or not in PATH
- Solution: Download from python.org and reinstall, checking "Add to PATH"

### **Backend won't start**
```bash
# Check if dependencies are installed
pip list | grep flask

# Reinstall everything
pip install --upgrade -r backend/requirements.txt
```

### **"Address already in use"**
- Port is taken by another process
- Solution: Kill the process or use different ports:
  ```bash
  python -m backend.server --port 5001
  python -m http.server 8001
  ```

### **"No module named 'flask'"**
- Virtual environment not activated
- Solution: Run `venv\Scripts\activate` first (Windows) or `source venv/bin/activate` (Mac/Linux)

### **Frontend loads but no data appears**
- Backend not running
- Solution: Check that `run_backend.bat` (or `python -m backend.server`) is open and showing "Running on http://127.0.0.1:5000"

---

## **File Structure**

```
H2Oolkit/
├── setup.bat              ← Run this FIRST on new device
├── run_backend.bat        ← Start backend (port 5000)
├── run_frontend.bat       ← Start frontend (port 8000)
├── index.html             ← Frontend page
├── js/
│   ├── app.js            ← Frontend logic
│   ├── api-client.js     ← API communication
│   └── data-bridge.js    ← Data handling
├── backend/
│   ├── server.py         ← Flask API
│   ├── analyzer.py       ← Analysis engine
│   ├── osm.py            ← OpenStreetMap search
│   ├── eu_hydro.py       ← EU-Hydro database
│   └── requirements.txt   ← Python dependencies
└── data/
    ├── springs.geojson   ← Spring data
    └── villages.json     ← Village data
```

---

## **Deactivating Virtual Environment**

When done, deactivate the virtual environment:
```bash
deactivate
```

---

## **Support**

For issues:
1. Check the troubleshooting section above
2. Verify all dependencies: `pip list`
3. Check backend logs in the terminal where it's running
4. Open browser console (F12) for frontend errors
