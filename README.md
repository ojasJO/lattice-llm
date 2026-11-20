# Lattice: pool the laptops around you into one LLM

Lattice turns every Windows laptop on your network into one inference cluster. Run one
command on each laptop, pair them from a dashboard (like Bluetooth), and then:

* **Pool** them: split a model's layers across laptops (pipeline parallelism), so a model
  that fits on no single laptop runs on the group.
* **Speculate**: run a small *draft* model on one laptop and the large *target* model on
  another (or across several). The target verifies the draft's tokens in batches.
* **Measure everything**: per-node CPU, GPU, VRAM, clock and power; every RPC message
  between laptops, decoded by type; draft acceptance per position; where each millisecond
  went (compute vs. network); and joules per token.
* **Run experiments**: sweep draft length × injected network latency × topology, then get
  plots and CSV for your report.

Inference is done by [llama.cpp](https://github.com/ggml-org/llama.cpp) (v1.0.0, build 12359) and its
`ggml-rpc` backend. Lattice is the distributed-systems layer around it: discovery,
authenticated pairing, artifact distribution, orchestration, metering, fault handling,
clock synchronisation and the research tooling.

---

## Setting up a laptop

Do this once on **every** laptop you want in the cluster (Windows 10 or 11). All laptops should be
on the same Wi-Fi network or hotspot.

### 1. Install Python (skip if you already have 3.10 or newer)

Open PowerShell and run:

```powershell
winget install -e --id Python.Python.3.12
```

Or download it from [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"**
during setup. Close and reopen PowerShell afterwards. You can check it with `py --version`.

### 2. Get Lattice

**Option A: download the ZIP (no git needed)**

1. Download [lattice-llm-main.zip](https://github.com/ojasJO/lattice-llm/archive/refs/heads/main.zip)
   (or on this page: green **Code** button → **Download ZIP**).
2. Right-click the ZIP → **Properties** → tick **Unblock** → **OK**. This stops Windows from asking
   about every script inside it.
3. Right-click → **Extract All…**, for example to `C:\lattice-llm-main`.

**Option B: git**

```powershell
git clone https://github.com/ojasJO/lattice-llm.git
```

**Option C: from a laptop that already runs Lattice.** Open `http://<that-laptop's-ip>:7470/get` in a
browser. The address is printed in its terminal and shown under *Devices → Invite another laptop*.

### 3. Start it

Open PowerShell in the folder (in Explorer: open the folder, click the address bar, type `powershell`,
press Enter) and run:

```powershell
.\start.bat
```

You can also double-click `start.bat`.

* The first run takes about a minute. It creates a private Python environment in `.venv` and installs
  `aiohttp` and `psutil` (about 5 MB). Later starts are instant.
* Your browser opens the dashboard at `http://127.0.0.1:7470`.
* When Windows Firewall asks about Python, tick **Private networks** and press **Allow**. Without this,
  the other laptops can't see this one.
* Keep the terminal window open while you use Lattice. To stop it, press `Ctrl+C` or close the window.

The repository has no models or binaries in it. The llama.cpp runtime (38 MB) and the models are
downloaded from inside the app the first time they're needed. A paired laptop that already has them
serves them over the LAN, so only one laptop needs a fast Internet connection.

### Updating

Use the same version of Lattice on every laptop. To update, run `git pull` in the folder, or download
the ZIP again and copy your old `data\` and `models\` folders into the new one. That keeps your pairings,
run history and downloaded models.

---

## Using it

With Lattice running on each laptop:

1. **Devices.** Each laptop appears under *Nearby* within a couple of seconds. Press **Connect**.
2. The other laptop shows **Connection request** with a 6-digit code. Check that it matches, then press **Approve**.
3. **Models.** Download a target model and a draft model from the same family (for example
   *Qwen2.5 1.5B* + *Qwen2.5 0.5B*). If a paired laptop already has a file, it is copied over the LAN.
4. **Launch.** Pick a strategy, tick the laptops, then press **Launch cluster**. Workers receive the llama.cpp
   runtime and the weights from this laptop automatically.
5. **Playground.** Chat with the cluster. Every reply is measured.
6. **Experiments.** Run sweeps and export CSV/JSON.

### Troubleshooting

**Laptops can't see each other:**
* The usual cause: a laptop shows up under *Nearby*, but **Connect** does nothing and the other laptop
  never shows the approval prompt. Windows Firewall is blocking incoming connections. This always happens
  on Wi-Fi marked **Public**, which includes most campus networks. Fix it on **each** laptop: right-click
  `tools\allow-firewall.bat` → **Run as administrator**. It opens Lattice's ports to devices on your own
  network only, on both Private and Public Wi-Fi. No restart is needed.
* If a laptop still doesn't show up under *Nearby*, add it by IP under *Devices → Add by IP*. Find a
  laptop's IP in its Lattice terminal, or with `ipconfig`.
* Campus or hotel Wi-Fi often blocks laptop-to-laptop traffic completely ("client isolation"). Use a
  phone hotspot or an Ethernet cable instead.

**`start.bat` says Python wasn't found, or typing `python` opens the Microsoft Store:** install Python as
in step 1, then reopen PowerShell. If it still fails, turn off the store shortcut: *Settings → Apps →
Advanced app settings → App execution aliases →* switch off **python.exe** and **python3.exe**.

**"Windows protected your PC" or a security warning when starting:** you skipped *Unblock* on the ZIP.
Click **Run** (or **More info → Run anyway**), or run `Get-ChildItem -Recurse | Unblock-File` in the folder once.

**Something else went wrong:** the *Logs* page in the dashboard shows Lattice's own events and the
llama.cpp output. Log files are in `data\logs\`.

---

## Architecture

```
            ┌───────────────────────── Coordinator laptop ─────────────────────────┐
 browser ─► │ dashboard (SPA) ⇄ WebSocket ⇄ Lattice node (Python, aiohttp)         │
            │                                  │ spawns                            │
            │                     llama-server (127.0.0.1) ── local GPU (direct)   │
            │                         │ ggml-rpc over TCP                          │
            └─────────────────────────┼───────────────────────────────────────────┘
                      ┌───────────────┴────────────────┐
             ┌────────▼────────┐              ┌────────▼────────┐
             │ worker laptop A │              │ worker laptop B │   … up to 15
             │  Lattice gate   │ ← metered,   │  Lattice gate   │
             │  (LAN :7480)    │   allow-list,│  (LAN :7480)    │
             │       │         │   latency    │       │         │
             │ ggml-rpc-server │   injection  │ ggml-rpc-server │
             │ (127.0.0.1 only)│              │ (127.0.0.1 only)│
             └─────────────────┘              └─────────────────┘
   all nodes: UDP multicast discovery · HMAC-signed control plane · 1 Hz heartbeats + clock sync
```

| Concern | How Lattice handles it |
|---|---|
| **Membership & discovery** | JSON beacons every 2 s via multicast `239.255.74.71:7471` and directed broadcast on every interface; entries expire after 8 s; manual add-by-IP fallback. |
| **Trust** | Bluetooth-style pairing. The target shows an approval prompt with a 6-digit code; on approval both sides store a 256-bit secret. Every node-to-node call carries `HMAC-SHA256(secret, ts‖method‖path)` with a ±15 min freshness window. |
| **Failure detection** | 1 Hz heartbeats; a peer is declared offline after 3 misses. A worker whose coordinator has been gone for 45 s releases its resources. All child processes live in a Windows Job Object, so nothing is orphaned if Lattice crashes. |
| **Clock synchronisation** | NTP-style four-timestamp exchange on every heartbeat. Offset θ = ((t1−t0)+(t2−t3))/2 with the minimum-delay filter over the last 8 samples; error bound ±δ/2 (shown under *Devices*). |
| **Artifact distribution** | The llama.cpp runtime (38 MB) and GGUF models are served peer-to-peer over authenticated HTTP with resumable range requests. Sources are tried LAN-first, then the Internet. The coordinator pushes weights to workers over RPC; workers cache them by hash, so relaunches take about 2 s. |
| **Placement** | Layer split with `-ts` weights (by free memory, equal, or manual). Lattice mirrors llama.cpp's split rule to predict per-stage layers and memory before launch. |
| **Security** | The dashboard answers only `127.0.0.1` and is CSRF-guarded. The rpc-server binds to loopback only and is reachable solely through the gate, which admits just the coordinator that holds the current lease. |
| **Observability** | The gate decodes the ggml-rpc wire protocol (v10): `cmd u8 · size u64 · payload` requests, and `size u64 · payload` responses for the 13 commands that reply. Bytes and round-trip latency are attributed per command (`SET_TENSOR` = weight/activation upload, `GRAPH_COMPUTE` = run layers, `GET_TENSOR` = fetch results). |

### Strategies

| Strategy | What runs where |
|---|---|
| Single node | Whole model on one device: the baseline. |
| Pooled | Layers split across N laptops in the order you choose (pipeline parallel). |
| Speculative | Target on one laptop, draft model on any laptop (local or remote via RPC). |
| Pooled + speculative | Both at once. |
| Advanced | N-gram self-speculation (no draft model); route this laptop through RPC too, to measure RPC overhead. |

---

## What gets measured

Every generation is logged to `data/runs.jsonl`. *Runs* exports it as CSV.

| Metric | Source |
|---|---|
| TTFT, end-to-end tok/s, inter-token latency p50/p95/max | client-side timestamps of streamed chunks |
| Prefill tok/s, decode tok/s | llama.cpp `timings` |
| Draft acceptance, tokens per verification step | llama.cpp `draft_n` / `draft_n_accepted` and Prometheus `spec_decode_num_drafts_total` |
| Acceptance by draft position | Prometheus `spec_decode_num_accepted_tokens_per_pos_total` (deltas per run) |
| Bytes moved per node, bytes per token | Lattice gates (exact) |
| Compute vs network time per node | gate response latency minus injected delay (compute); awaited calls × (RTT + injected delay) (network) |
| GPU power, J/token | NVML power integrated over the run (NVIDIA) |
| CPU effective clock (throttling) | Windows PDH `% Processor Performance` × base frequency |
| GPU utilisation incl. Lattice's own share | Windows PDH `GPU Engine` counters, attributed per process |

### Example (measured while building this, on one machine with simulated nodes)

Qwen2.5 1.5B Q4_K_M target, Qwen2.5 0.5B draft, greedy decoding, 64 tokens:

| Arm | Decode tok/s | Accept | Network / token |
|---|---|---|---|
| Pooled ×2, no draft, +0 ms | 172 | – | 45 KB |
| Pooled ×2, no draft, +20 ms RTT | 32 | – | 44 KB |
| Pooled ×2 + remote draft (n=2), +0 ms | 86 | 92% | 941 KB |
| Pooled ×2 + remote draft (n=8), +0 ms | 77 | 78% | 925 KB |
| Single node + local draft (n=8) | 150 | 78% | 0 |

Findings already visible in this small sweep:

1. **Stage order matters.** The last pipeline stage computes the output head, so if it is remote, every
   token ships the full logit vector back (151,936 × 4 B ≈ 594 KB). Putting the coordinator last cuts traffic
   to about 6 KB of activations per hop. The Launch page warns about this.
2. **A remote draft is latency-bound.** Each draft token is a network round trip that returns draft logits.
   On a fast GPU target, a remote draft costs more than it saves. Speculation pays off when the target is slow
   (big model, CPU, or split across laptops) and the draft is local.
3. **Pipeline parallelism is RTT-bound.** At +20 ms RTT throughput drops about 5×, even though bandwidth is tiny.

### Research questions you can answer with the Experiments page

* At what RTT does pooling stop beating a single laptop, for a model that fits on one?
* What is the best draft length *n*? Acceptance falls geometrically with position (see *Acceptance by
  draft position*); the optimum shifts with RTT.
* Does task type matter? Code and JSON accept far more draft tokens than creative writing.
* Draft on the coordinator vs on a worker vs on the slowest laptop: where should the draft live?
* Heterogeneity: does a "by free memory" split beat "equal" when one laptop throttles? Watch the
  effective clock on the Vostro.
* Energy: J/token for 1 laptop vs N laptops.
* Clock sync quality: compare the NTP-style offset error bound with the RTT.

---

## Reference

**Command line:** `start.bat [--port 7470] [--name NAME] [--home DIR] [--no-browser] [--no-discovery]`.
To run several nodes on one PC for development, give each its own port block and home directory:
`start.bat --port 7570 --home .node2 --name Test2`.

**Ports (relative to `--port`, default 7470):** `+0` dashboard/peer API · `+10` RPC gate (LAN) ·
`+11` rpc-server (loopback) · `+20` llama-server (loopback) · UDP 7471 discovery.

**OpenAI-compatible API:** while a cluster is running, `http://127.0.0.1:7490/v1` works with any
OpenAI client on the coordinator laptop.

**Files:** `data/` holds identity, peers, settings, runs, experiments and logs; `models/` holds GGUF files
(drop your own in); `runtime/` holds the llama.cpp build. All three are local to each laptop and git-ignored.

**Code map:** `lattice/discovery.py` (beacons) · `peers.py` (pairing, HMAC, heartbeats, clock offset) ·
`gate.py` (ggml-rpc decoder, metering, latency injection) · `runtime.py` (llama.cpp install, devices,
worker role) · `session.py` (coordinator, placement, launch state machine) · `inference.py` (measured
generation) · `experiments.py` (sweeps) · `telemetry.py` + `winmetrics.py` (PDH/DXGI/NVML via ctypes) ·
`web/` (dashboard, no build step).

**Limitations:**
* Windows only, because the runtime is the Vulkan x64 llama.cpp build. It includes CPU backends, so it also
  works on laptops without a usable GPU.
* ggml-rpc is still marked experimental upstream.
* One coordinator per worker at a time.
* Draft and target must share a tokenizer (the UI only offers compatible pairs).

Models are downloaded from Hugging Face under their own licences (Qwen: Apache-2.0 / Qwen licence;
Llama: Meta Llama licence). llama.cpp is MIT-licensed.
