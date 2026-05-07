#!/usr/bin/env python3
"""Generate audio for each story via Sarvam TTS, save as audio/story-N.mp3."""
import json, os, sys, base64, urllib.request, urllib.error, concurrent.futures, subprocess, tempfile, time, re

API_KEY = "sk_lia9nbh2_lBTw18xYAt2UHnQhFtlmXDia"
ENDPOINT = "https://api.sarvam.ai/text-to-speech"
MODEL = "bulbul:v3"
SPEAKER = "aditya"  # male
LANG = "en-IN"
MAX_CHARS = 2400  # safe under 2500 limit

ROOT = "/Users/popeye/story-website"
AUDIO_DIR = os.path.join(ROOT, "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)

with open(os.path.join(ROOT, "stories.json")) as f:
    stories = json.load(f)

def chunk_text(text, max_chars=MAX_CHARS):
    """Split into <=max_chars chunks at sentence/paragraph boundaries."""
    text = text.strip()
    if len(text) <= max_chars: return [text]
    # Prefer paragraph splits, then sentence splits
    out = []
    paragraphs = text.split("\n\n")
    cur = ""
    for p in paragraphs:
        p = p.strip()
        if not p: continue
        if len(cur) + len(p) + 2 <= max_chars:
            cur = (cur + "\n\n" + p) if cur else p
        else:
            if cur: out.append(cur)
            if len(p) <= max_chars:
                cur = p
            else:
                # Split a single mega paragraph by sentences
                sentences = re.findall(r"[^.!?]+[.!?]+[\")']?", p) or [p]
                buf = ""
                for s in sentences:
                    if len(buf) + len(s) + 1 <= max_chars:
                        buf += (" " if buf else "") + s.strip()
                    else:
                        if buf: out.append(buf)
                        buf = s.strip()
                if buf: cur = buf
                else: cur = ""
    if cur: out.append(cur)
    return out

def tts_one(chunk):
    body = json.dumps({
        "text": chunk,
        "target_language_code": LANG,
        "model": MODEL,
        "speaker": SPEAKER,
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"api-subscription-key": API_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read())
            audios = data.get("audios", [])
            if not audios: raise RuntimeError("no audio in response")
            return base64.b64decode(audios[0])
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                wait = 15 * (attempt + 1)  # 15s, 30s, 45s, 60s, 75s
                time.sleep(wait); continue
            raise
        except Exception as e:
            if attempt < 5: time.sleep(2 + attempt * 2); continue
            raise

def encode_mp3(wav_paths, out_mp3):
    if len(wav_paths) == 1:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_paths[0],
             "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", out_mp3],
            check=True
        )
    else:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            for p in wav_paths: f.write(f"file '{p}'\n")
            list_path = f.name
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                 "-i", list_path, "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", out_mp3],
                check=True
            )
        finally:
            os.unlink(list_path)

def process(story):
    out_mp3 = os.path.join(AUDIO_DIR, f"story-{story['id']}.mp3")
    if os.path.exists(out_mp3) and os.path.getsize(out_mp3) > 1000:
        return story["id"], "cached", os.path.getsize(out_mp3)
    chunks = chunk_text(story["content"])
    wav_files = []
    try:
        for i, chunk in enumerate(chunks):
            wav_bytes = tts_one(chunk)
            wp = os.path.join(AUDIO_DIR, f"_tmp-{story['id']}-{i}.wav")
            with open(wp, "wb") as f: f.write(wav_bytes)
            wav_files.append(wp)
        encode_mp3(wav_files, out_mp3)
        return story["id"], "ok", os.path.getsize(out_mp3)
    except Exception as e:
        return story["id"], f"ERR {type(e).__name__}: {e}", 0
    finally:
        for w in wav_files:
            try: os.unlink(w)
            except: pass

# Run with parallelism
WORKERS = int(os.environ.get("WORKERS", "8"))
todo = [s for s in stories if not (
    os.path.exists(os.path.join(AUDIO_DIR, f"story-{s['id']}.mp3")) and
    os.path.getsize(os.path.join(AUDIO_DIR, f"story-{s['id']}.mp3")) > 1000
)]
print(f"Generating audio for {len(todo)} of {len(stories)} stories with {WORKERS} workers...", flush=True)

t0 = time.time()
ok = err = cached = 0
with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    futures = [ex.submit(process, s) for s in todo]
    for done, fut in enumerate(concurrent.futures.as_completed(futures), 1):
        sid, status, size = fut.result()
        if status == "ok": ok += 1
        elif status == "cached": cached += 1
        else:
            err += 1
            print(f"  ✗ story-{sid}: {status}", flush=True)
        if done % 10 == 0 or done == len(todo):
            elapsed = time.time() - t0
            print(f"  {done}/{len(todo)}  ok={ok}  err={err}  cached={cached}  elapsed={elapsed:.0f}s", flush=True)

print(f"\nDone. ok={ok} err={err} cached={cached} total_time={time.time()-t0:.0f}s")

# Write a tiny index so the SW knows which audio files exist
manifest = []
for s in stories:
    p = os.path.join(AUDIO_DIR, f"story-{s['id']}.mp3")
    if os.path.exists(p) and os.path.getsize(p) > 1000:
        manifest.append({"id": s["id"], "size": os.path.getsize(p)})
with open(os.path.join(ROOT, "audio_manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(f"Wrote audio_manifest.json with {len(manifest)} entries")
