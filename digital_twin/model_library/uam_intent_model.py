"""The runnable mission-conditioned baseline, separate from delivered networks."""
MODEL_ID = "uam_mission_kinematic_v1"
MODEL = {
    "model_id": MODEL_ID, "label": "임무·비행 단계 예측", "family": "kinematic",
    "function": "궤적 예측", "application": "UAM", "applies_to": ["uam"],
    "scope": "최대 240초", "jobs": ["uam_prediction"], "ready": True, "reason": "",
    "requires": "현재 위치·실제 속도·활성 경유점·비행 단계",
    "note": "실제 속도에서 출발해 남은 경유점과 단계별 속도·상승·강하 제한을 반영합니다. "
            "대기 해제를 미리 가정하지 않습니다. 임무 정보가 없으면 짧은 등속 예측으로 표시합니다.",
}
