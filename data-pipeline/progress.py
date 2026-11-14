"""Show download progress for the CAIRN data pipeline.  Usage: python progress.py [--watch]"""
import os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
SIZES = {"ctx_dtm.tif": 9662387, "ctx_ortho.tif": 36269402}


def bar(done, total, width=30):
    frac = min(1.0, done / total) if total else 0
    fill = int(width * frac)
    return "[" + "█" * fill + "░" * (width - fill) + f"] {int(100 * frac):3d}%"


def size(name):
    for p in (os.path.join(RAW, name), os.path.join(RAW, name + ".part")):
        if os.path.exists(p):
            return os.path.getsize(p)
    return 0


def report():
    log_path = os.path.join(RAW, "fetch_terrain.log")
    log = open(log_path).read().splitlines() if os.path.exists(log_path) else []
    lines = [f"{'CTX regional elevation':24s}{bar(size('ctx_dtm.tif'), SIZES['ctx_dtm.tif'])}",
             f"{'CTX regional image':24s}{bar(size('ctx_ortho.tif'), SIZES['ctx_ortho.tif'])}"]
    for name, label in (("aoi_dtm_1m.npy", "HiRISE elevation (1 m)"), ("aoi_ortho_25cm.npy", "HiRISE image (25 cm)")):
        if os.path.exists(os.path.join(RAW, name)):
            lines.append(f"{label:24s}{bar(1, 1)}  done"); continue
        hits = [m for m in (re.search(r"rows (\d+)/(\d+) \((\d+)s\)", l) for l in log if name in l) if m]
        if hits:
            done, total, secs = map(int, hits[-1].groups())
            left = int(secs * (total - done) / max(done, 1))
            lines.append(f"{label:24s}{bar(done, total)}  {secs}s elapsed, ~{left}s left")
        else:
            lines.append(f"{label:24s}{bar(0, 1)}  waiting")
    rad = os.path.join(RAW, "rad")
    n = len(os.listdir(rad)) if os.path.isdir(rad) else 0
    lines.append(f"{'RAD radiation files':24s}{bar(n, 12)}  {n}/12 files")
    return "\n".join(lines)


if __name__ == "__main__":
    if "--watch" in sys.argv:
        while True:
            print("\033[2J\033[H" + report(), flush=True); time.sleep(2)
    else:
        print(report())
