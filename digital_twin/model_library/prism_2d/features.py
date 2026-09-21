"""Minimal numerical port of PRISM build_sample(with_labels=False).

File loading, training labels and GT metadata are deliberately absent.
"""
import numpy as np
from .constants import AGE_SCALE,F_DIM,GAP_SCALE,HIST_STEPS,LOG_DT,POS_SCALE,R_SCALE,VEL_SCALE
HEADING_MIN_DISP = 0.3
OWNSHIP_POS_STD = 0.5

def _rot_matrix(theta: float) -> np.ndarray:
    """World -> frame rotation: v_frame = R @ v_world."""
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, s], [-s, c]], dtype=np.float64)


def build_features(ep: dict, t0: int, target: int, data_cfg: dict) -> dict:
    """Observation-only feature transform; no labels or ground truth accepted."""
    A = int(data_cfg.get("max_agents", 8))
    det_all = ep["obs_detected"].astype(bool)
    N = det_all.shape[1]
    h0 = t0 - HIST_STEPS + 1
    W = slice(h0, t0 + 1)

    det = det_all[W]                                # [H,N] bool
    pos_raw = ep["obs_pos"][W].astype(np.float64)   # [H,N,2] NaN when ~det
    R_raw = ep["obs_R"][W].astype(np.float64)       # [H,N,2,2]
    age_raw = ep["obs_track_age"][W].astype(np.float64)
    own = ep["own_pos"][W].astype(np.float64)       # [H,2]

    # ---------------------------------------------------------------- frame
    hs = np.nonzero(det[:, target])[0]
    p_last = pos_raw[hs[-1], target]
    theta = 0.0
    for h_prev in hs[:-1][::-1]:
        d = p_last - pos_raw[h_prev, target]
        if float(np.hypot(d[0], d[1])) >= HEADING_MIN_DISP:
            theta = float(np.arctan2(d[1], d[0]))
            break
    Rm = _rot_matrix(theta)
    origin = p_last

    # ------------------------------------------------------- slot selection
    # slot 0 = target, slot 1 = ownship, slots 2.. = nearest other agents
    others = []
    for a in range(N):
        if a == target or not det[:, a].any():
            continue
        pl = pos_raw[np.nonzero(det[:, a])[0][-1], a]
        others.append((float(np.hypot(*(pl - origin))), a))
    others.sort()
    slots = [("agent", target), ("ownship", -1)] + \
            [("agent", a) for _, a in others[: max(0, A - 2)]]

    x = np.zeros((A, HIST_STEPS, F_DIM), dtype=np.float32)
    agent_mask = np.zeros(A, dtype=np.float32)

    for si, (kind, a) in enumerate(slots):
        agent_mask[si] = 1.0
        if kind == "ownship":
            d_s = np.ones(HIST_STEPS, dtype=bool)
            p_s = own
            R_s = np.broadcast_to(np.eye(2) * OWNSHIP_POS_STD ** 2,
                                  (HIST_STEPS, 2, 2))
            age_s = np.full(HIST_STEPS, AGE_SCALE)
        else:
            d_s = det[:, a]
            p_s = pos_raw[:, a]
            R_s = R_raw[:, a]
            age_s = age_raw[:, a]

        m = d_s.astype(np.float64)
        # relative position in frame; np.where kills the NaN of undetected rows
        rel = (p_s - origin) @ Rm.T
        rel = np.where(d_s[:, None], rel, 0.0)
        rel = np.nan_to_num(rel, nan=0.0)

        # finite-difference velocity over consecutive detected steps
        dv = np.zeros((HIST_STEPS, 2))
        dvalid = np.zeros(HIST_STEPS)
        both = d_s[1:] & d_s[:-1]
        step_v = (p_s[1:] - p_s[:-1]) / LOG_DT @ Rm.T
        dv[1:] = np.where(both[:, None], step_v, 0.0)
        dv = np.nan_to_num(dv, nan=0.0)
        dvalid[1:] = both

        # measurement covariance rotated into the frame
        Rf = Rm @ np.nan_to_num(R_s, nan=0.0) @ Rm.T          # [H,2,2]
        r00 = np.clip(Rf[:, 0, 0], 0.0, None)
        r11 = np.clip(Rf[:, 1, 1], 0.0, None)
        denom = np.sqrt(r00 * r11) + 1e-9
        rho_r = np.clip(Rf[:, 0, 1] / denom, -1.0, 1.0)

        # steps since the previous detection (0 at a detected step)
        gap = np.zeros(HIST_STEPS)
        last = -1
        for h in range(HIST_STEPS):
            if d_s[h]:
                last = h
                gap[h] = 0.0
            else:
                gap[h] = (h - last) if last >= 0 else (h + 1)

        x[si, :, 0] = rel[:, 0] / POS_SCALE
        x[si, :, 1] = rel[:, 1] / POS_SCALE
        x[si, :, 2] = m
        x[si, :, 3] = dv[:, 0] / VEL_SCALE
        x[si, :, 4] = dv[:, 1] / VEL_SCALE
        x[si, :, 5] = dvalid
        x[si, :, 6] = np.sqrt(r00) / R_SCALE * m
        x[si, :, 7] = np.sqrt(r11) / R_SCALE * m
        x[si, :, 8] = rho_r * m
        x[si, :, 9] = np.clip(age_s * m, 0, 10 * AGE_SCALE) / AGE_SCALE
        x[si, :, 10] = np.clip(gap, 0, 2 * GAP_SCALE) / GAP_SCALE
        x[si, :, 11] = 1.0 if kind == "ownship" else 0.0
        x[si, :, 12] = 1.0 if si == 0 else 0.0

    return {"x": x, "agent_mask": agent_mask,
            "frame": np.array([origin[0], origin[1], theta], dtype=np.float64)}
