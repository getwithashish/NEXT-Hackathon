# Model Fingerprinting Hackathon - 12hr Plan

## Vision
**Model Verification App**: Help users verify that their LLM/AI model is authentic (not cloned/distilled).
- **Input A**: LLM API key + address → probe behavior → fingerprint
- **Input B**: .onnx/.pth upload → analyze weights/activations → fingerprint
- **Output**: Fingerprint + similarity scores to known models + verdict (authentic/suspicious)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKEND (Python)                          │
├─────────────────────────────────────────────────────────────┤
│ Agent 1: Model Loader         (handles .pth/.onnx uploads)   │
│ Agent 2: Behavioral Prober    (probes API LLMs)              │
│ Agent 3: Fingerprint Generator (computes 3-modal signature)  │
│ Agent 4: Similarity Comparator (finds similar models)        │
├─────────────────────────────────────────────────────────────┤
│ FastAPI Server (3-4 endpoints)                               │
│ SQLite DB (fingerprints + comparison cache)                  │
├─────────────────────────────────────────────────────────────┤
│ AWS S3 (model upload storage) + Lambda (optional GPU)        │
└─────────────────────────────────────────────────────────────┘
            ↕
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (React/Next.js)                  │
├─────────────────────────────────────────────────────────────┤
│ Upload Form (model file)                                      │
│ API Input Form (endpoint + key)                               │
│ Results Dashboard (fingerprint + verdict + similar models)   │
│ Deploy: Vercel                                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 12-Hour Sprint Breakdown

### **Hour 0-1: Setup & Foundation** ⚙️
- [ ] Backend project skeleton (FastAPI, SQLite, venv)
- [ ] Research toolkit integration (copy fingerprinting modules)
- [ ] AWS S3 bucket + credentials setup
- [ ] Claude API key configured

**Deliverable**: `python main.py` runs without errors

---

### **Hour 1-3: Backend Core (Agent Layer)** 🤖

**Agent 1: Model Loader** (30 min)
- Load .pth via `torch.load()`
- Load .onnx via `onnx.load()` + `onnxruntime`
- Extract layer names, shapes, parameter counts
- Store in temp dir or S3

**Agent 2: Behavioral Prober** (45 min)
- Accept API endpoint + key
- Probe with 20 diverse prompts (QA, reasoning, jailbreaks)
- Extract token probabilities, entropy, response patterns
- Cache results

**Agent 3: Fingerprint Generator** (45 min)
- Integrate weight-based fingerprinting (layer stats, spectral analysis)
- Integrate behavioral fingerprinting (probability distributions)
- For local models: add activation pattern analysis
- Return combined fingerprint hash + metadata

**Agent 4: Similarity Comparator** (30 min)
- Query known model fingerprints (seed DB with ~10-20 models)
- Compute distances (Euclidean, cosine, KL divergence)
- Return top-5 similar models + confidence scores
- Store fingerprint in DB

**Deliverable**: 4 standalone Python classes, testable independently

---

### **Hour 3-5: FastAPI Server & Endpoints** 🚀

**Endpoint 1: `/fingerprint/api`** (POST)
```
Input: { "api_endpoint": "...", "api_key": "..." }
Output: { "fingerprint": "...", "similar_models": [...], "confidence": 0.95 }
```

**Endpoint 2: `/fingerprint/upload`** (POST, file upload)
```
Input: multipart file (.pth or .onnx)
Output: { "fingerprint": "...", "similar_models": [...], "verdict": "authentic|suspicious" }
```

**Endpoint 3: `/compare`** (POST)
```
Input: { "fingerprint_1": "...", "fingerprint_2": "..." }
Output: { "distance": 0.05, "similarity": 0.95 }
```

**Endpoint 4: `/models` (GET)**
```
Output: { "known_models": [...] } (list of reference models in DB)
```

**Deliverable**: All 4 endpoints working, error handling in place, CORS enabled

---

### **Hour 5-7: Frontend (React/Next.js)** 🎨

**Page 1: Upload**
- Drag-drop for .pth/.onnx
- Display upload progress
- Show fingerprint once complete

**Page 2: API Input**
- Form for endpoint + API key
- Async probe status (with spinner)
- Show fingerprint + similar models once done

**Page 3: Results**
- Fingerprint display (formatted nicely)
- Similar models table (name, similarity %, reason)
- Verdict badge (✅ Authentic / ⚠️ Suspicious / ❓ Uncertain)

**Deliverable**: All pages functional, connected to backend, styled

---

### **Hour 7-9: Integration & Testing** 🧪

**Test Full Flow A:**
- Upload small model (found online) → verify fingerprint generated → check DB
- **Expected**: ✅ Fingerprint hash stored, similar models found

**Test Full Flow B:**
- Use Claude API → probe → generate fingerprint
- **Expected**: ✅ Behavioral fingerprint matches known Claude pattern

**Test Similarity:**
- Compare two models → verify distance < 0.1 if same, > 0.3 if different
- **Expected**: ✅ Distances make sense

**Deploy Frontend to Vercel:**
- Push to GitHub → Vercel auto-deploys
- Test live endpoint connectivity

**Deliverable**: E2E demo working, at least 1 happy path

---

### **Hour 9-11: Polish & Demo Prep** ✨

- Error messages user-friendly
- Edge cases handled (invalid API key, corrupt file, timeout)
- DB pre-seeded with known models (OpenAI, Anthropic, Meta, etc.)
- Performance: fingerprinting < 2 min for API, < 1 min for local
- Results page shows *why* a model is similar (e.g., "Same weight distribution", "Identical token probabilities")

**Deliverable**: Polished, demo-ready application

---

### **Hour 11-12: Demo & Documentation** 📝

- Write quick README (how to run, what it does)
- Record 2-min demo walkthrough
- Prepare talking points:
  - Problem solved (model authenticity)
  - Technical approach (3 fingerprinting methods)
  - Key achievements (E2E system in 12 hours)
- Have backup: if live demo fails, show video

**Deliverable**: Ready to present to judges

---

## Key Agents Needed

| Agent | Input | Output | Time |
|-------|-------|--------|------|
| **ModelLoader** | .pth/.onnx file | Model object + metadata | 30 min |
| **BehavioralProber** | API endpoint + key | Probability distributions | 45 min |
| **FingerprintGen** | Model (any form) | Fingerprint hash | 45 min |
| **SimilarityComp** | 2 fingerprints | Distance + similarity % | 30 min |

---

## Tech Stack (Locked)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Backend | Python + FastAPI | Fast, minimal boilerplate |
| LLM | Claude (Anthropic) | Better reasoning for probing |
| DB | SQLite | No setup, file-based, hackathon-ready |
| Models | torch + onnxruntime | Support .pth + .onnx natively |
| Fingerprint | Research toolkit (provided) | 950+ LOC, battle-tested |
| Frontend | React + Next.js | Vercel integration, SSR |
| Deploy | Vercel + AWS S3 | Serverless, no EC2 overhead |

---

## Quick Reference: File Structure

```
hackathon-model-verify/
├── backend/
│   ├── main.py                    # FastAPI server
│   ├── agents/
│   │   ├── model_loader.py
│   │   ├── behavioral_prober.py
│   │   ├── fingerprint_gen.py
│   │   └── similarity_comp.py
│   ├── models.db                  # SQLite
│   ├── requirements.txt
│   └── .env                       # API keys
├── frontend/
│   ├── pages/
│   │   ├── index.js               # Upload page
│   │   ├── api.js                 # API input page
│   │   └── results.js             # Results page
│   ├── public/
│   └── package.json
└── README.md
```

---

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Model too large for upload | Pre-set 500MB limit, compress |
| API rate limits (probing) | Cache results, limit to 20 prompts |
| GPU not available on AWS | Fall back to CPU (slower but works) |
| Claude rate limit | Use local fingerprinting if API fails |
| Vercel deployment fails | Have GitHub Pages fallback |

---

## Success Criteria

✅ **MVP is done when:**
1. Backend fingerprinting works for ≥2 input types (API + local)
2. Frontend accepts both inputs + shows results
3. E2E demo: upload a model → get fingerprint → see similar models
4. Live deployment on Vercel works
5. Judges can understand the problem & solution in 5 min

---

## Next Steps

1. **NOW**: Review this plan → adjust if needed
2. **5 min**: Set up GitHub repo + Vercel project
3. **Start Hour 0**: Kickoff with backend skeleton
4. **Hour 12**: Finish line! 🎉

Ready to start? I can help with **any** part—code generation, debugging, API setup, deployment. Just ask! 🚀
