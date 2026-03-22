# Google Cloud Runbook (NMiAI 2026 Task 1)

This runbook trains on Google Cloud GPU, exports ONNX, and builds a policy-safe submission zip:

- `run.py`
- `model.onnx`

## 1) Local one-time setup (run on your Mac)

```bash
gcloud auth login
gcloud auth application-default login
```

Set variables:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="europe-west4"
export ZONE="europe-west4-a"
export VM_NAME="ngd-a100-1"
export NGD_ROOT="$HOME/path/to/NMIAI26/norgesgruppen-data"
```

Select project and enable APIs:

```bash
gcloud config set project "$PROJECT_ID"
gcloud services enable compute.googleapis.com storage.googleapis.com
```

## 2) Create GPU VM (A100)

If A100 quota/capacity is unavailable, use `g2-standard-24` (L4) and keep the rest of the flow identical.

```bash
gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --machine-type="a2-highgpu-1g" \
  --maintenance-policy=TERMINATE \
  --boot-disk-size=300GB \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --metadata=install-nvidia-driver=True \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

## 3) Copy only required files to VM

```bash
gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command "mkdir -p ~/nmiai_ngd"

gcloud compute scp \
  "$NGD_ROOT/data/raw/NM_NGD_coco_dataset.zip" \
  "$VM_NAME:~/nmiai_ngd/" \
  --zone "$ZONE"

gcloud compute scp --recurse \
  "$NGD_ROOT/src" \
  "$NGD_ROOT/scripts" \
  "$VM_NAME:~/nmiai_ngd/" \
  --zone "$ZONE"
```

## 4) Train on VM

SSH to VM:

```bash
gcloud compute ssh "$VM_NAME" --zone "$ZONE"
```

Then inside VM:

```bash
cd ~/nmiai_ngd
sudo apt-get update
sudo apt-get install -y python3-venv tmux zip unzip
nvidia-smi

python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
pip install ultralytics onnx onnxruntime pillow pyyaml

python src/data/prepare_yolo_dataset.py \
  --zip-path ./NM_NGD_coco_dataset.zip \
  --out-dir ./yolo_dataset \
  --val-ratio 0.12 \
  --seed 42
```

If `nvidia-smi` fails right after VM creation, reboot once and retry:

```bash
sudo reboot
```

Then reconnect with `gcloud compute ssh ...` and continue.

Start long training in `tmux`:

```bash
tmux new -s ngd
```

In `tmux`:

```bash
cd ~/nmiai_ngd
source .venv/bin/activate

python src/train/train_yolov8.py \
  --data ./yolo_dataset/data.yaml \
  --model yolo11x.pt \
  --epochs 150 \
  --imgsz 1280 \
  --batch 4 \
  --patience 45 \
  --workers 4 \
  --name ngd_gcp_y11x_1280_e150 \
  --device 0
```

Detach from `tmux`: `Ctrl+b` then `d`.

Reattach later:

```bash
tmux attach -t ngd
```

## 5) Export ONNX + build submission zip (inside VM)

```bash
cd ~/nmiai_ngd
source .venv/bin/activate

python - <<'PY'
from ultralytics import YOLO
YOLO("runs/ngd_gcp_y11x_1280_e150/weights/best.pt").export(
    format="onnx",
    imgsz=1280,
    opset=17,
    simplify=True,
)
PY

chmod +x scripts/build_submission.sh
scripts/build_submission.sh \
  ./runs/ngd_gcp_y11x_1280_e150/weights/best.onnx \
  ./submission_gcp.zip
```

Quick checks:

```bash
python - <<'PY'
from pathlib import Path
import zipfile

z = Path("submission_gcp.zip")
assert z.exists(), "missing zip"
print("zip size MB:", round(z.stat().st_size/1024/1024, 2))
with zipfile.ZipFile(z) as f:
    names = sorted(f.namelist())
print("zip contents:", names)
assert names == ["model.onnx", "run.py"], names
PY
```

## 6) Copy submission zip back to your Mac

Run on your Mac terminal:

```bash
mkdir -p "$NGD_ROOT/evaluation/gcp"
gcloud compute scp \
  "$VM_NAME:~/nmiai_ngd/submission_gcp.zip" \
  "$NGD_ROOT/evaluation/gcp/submission_gcp_$(date +%Y%m%d_%H%M).zip" \
  --zone "$ZONE"
```

## 7) Stop/delete VM when done (avoid surprise cost)

```bash
gcloud compute instances stop "$VM_NAME" --zone "$ZONE"
# or delete permanently:
# gcloud compute instances delete "$VM_NAME" --zone "$ZONE" --quiet
```

## Notes

- Competition upload cap is 420 MB; this package should be much smaller.
- ONNX includes weights; do not include `.pt` in final zip.
- Keep final zip strictly to `run.py` + `model.onnx` to minimize policy risk.
