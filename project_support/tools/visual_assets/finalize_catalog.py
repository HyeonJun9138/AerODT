"""Attach matching browser evidence, thumbnails, and a rights-filtered web index."""
import json
from collections import Counter

from asset_library import ROOT, LIBRARY, SOURCES, eligible_for_web, file_record, safe_path, validate_library, write_json


def main():
    evidence = ROOT / "data/workspace/visual_assets/browser"
    catalog = json.loads((LIBRARY / "catalog.json").read_text(encoding="utf-8"))
    items, web, blocked = [], [], []
    for row in catalog["assets"]:
        path = safe_path(LIBRARY, row["metadata"])
        meta = json.loads(path.read_text(encoding="utf-8"))
        proof = json.loads((evidence / (row["asset_id"] + ".json")).read_text(encoding="utf-8"))
        if proof["sha256"] != meta["model"]["sha256"]:
            raise ValueError(f"stale browser receipt: {row['asset_id']}")
        meta["validation"]["browser"] = proof["status"]
        meta["validation"]["browser_scope"] = proof.get("scope", "failed")
        meta["validation"]["browser_sha256"] = proof["sha256"]
        if row["asset_id"] in ("cluster_ii", "cnofs", "polar", "van_allen"):
            meta["display"]["preview_note"] = "Default full-scene thumbnail has a small silhouette. Dedicated framing/scale review recommended; browser loading is not a visual-quality certification."
        if proof["status"] == "passed":
            image = evidence / (row["asset_id"] + ".jpg")
            (path.parent / "thumbnail.jpg").write_bytes(image.read_bytes())
            meta["thumbnail"] = file_record(path.parent / "thumbnail.jpg", "thumbnail.jpg")
            meta["display"]["browser_measured_extent"] = proof["native_extent"]
            meta["geometry"]["rendered_triangles"] = proof["triangles"]
        write_json(path, meta)
        items.append(meta)
        if eligible_for_web(meta):
            base = path.parent.relative_to(LIBRARY).as_posix()
            web.append({"asset_id": meta["asset_id"], "title": meta["title"], "category": meta["category"],
                "metadata": row["metadata"], "model": base + "/model.glb", "thumbnail": base + "/thumbnail.jpg",
                "attribution": base + "/attribution.txt", "sha256": meta["model"]["sha256"]})
        else:
            blocked.append(meta["asset_id"])
    write_json(LIBRARY / "web_catalog.json", {"schema_version": 1,
        "scope": "Relative paths under visual_assets; candidate web integration index, not a blanket legal clearance or public deployment.",
        "assets": web, "excluded": blocked})
    counts = dict(Counter(x["category"] for x in items))
    summary = {"assets": len(items), "categories": counts, "model_bytes": sum(x["model"]["bytes"] for x in items),
        "public_index_assets": len(web), "rights_or_validation_excluded": blocked,
        "repaired_assets": [x["asset_id"] for x in items if x["conversion"]["operation"] != "none"],
        "gltf_passed": sum(x["validation"]["gltf_validator"] == "passed" for x in items),
        "gltf_warning_count": sum(x["validation"].get("gltf_warnings", 0) for x in items),
        "browser_passed": sum(x["validation"]["browser"] == "passed" for x in items),
        "bounds_or_forward_axis_certified": False, "fab_downloads_completed": 0}
    write_json(ROOT / "data/workspace/visual_assets/summary.json", summary)
    lines = ["# AeroDT 공유 3D 자산 라이브러리", "", f"고유 GLB {len(items)}개. 파일 전체 {summary['model_bytes'] / 1048576:.1f} MiB. 기본 장면의 glTF 및 WebGL 검증 기준이다.", "",
        "## 사용", "", "- `catalog.json`: 로컬 보유 전체 형상. `asset.json`이 모델 정보의 원본이다.",
        "- `web_catalog.json`: 출처 조건과 기술 검사를 통과한 후보만 참조한다. 공개 서버에 전체 디렉터리를 무조건 노출하지 않는다.",
        "- `acquisition.json`: 아직 받지 못한 Fab 상품. 보유 수량에 포함하지 않는다.",
        "- `model.glb`: glTF 2.0. Draco를 요구하는 모델은 뷰어에 해당 decoder를 구성해야 한다.",
        "- `thumbnail.jpg`: 실제 파일의 브라우저 기본 장면 렌더. 원본 공급자 홍보 이미지가 아니다.",
        "- `attribution.txt`: 출처와 이용 조건. 웹에서 사용자에게도 접근 가능하게 제공한다.", "",
        "## 구분", "", "민간 9개: A320, A350, A380, B737, B787, 범용 eVTOL, 드론, NASA X-57, ProjectAirSim AirTaxi.",
        "AirTaxi는 AeroDT 시뮬레이터가 쓰는 model package의 링크 배치를 그대로 Unreal에서 내보낸 것이라 크기와 축이 측정값이다.",
        "군용 계열 1개: Global Hawk. NASA 연구용 외형이며 실제 작전용 도색이나 센서 구성을 보증하지 않는다.",
        "위성/우주정거장 77개: ICDCDT 50개와 추가 NASA 27개. 동일 형상의 위성군 매핑은 aliases로 보존한다.",
        "위성의 exact/series/family는 이전 프로젝트의 식별 매핑이며 3D 형상의 정밀도 인증이 아니다.", "",
        "## 크기와 자세", "", "GLB는 오른손 좌표계 +Y-up 기준이지만 각 모델의 기수 방향은 별도 확인이 필요하다.",
        "`browser_measured_extent`는 장면 bounding box에서 측정한 원본 단위 크기다. 곧바로 실제 미터로 해석하지 않는다.",
        "ICDCDT의 `reference_extent_m`와 alias별 `size_m`은 근사 표시값이다. 동일 형상을 쓰는 alias마다 배율이 다를 수 있다.",
        "실제 세계 배율과 기수 방향 검증 전에는 지도 위 자세가 정확하다고 주장하지 않는다. 미리보기는 auto-fit만 한다.", "",
        "Cluster II, CNOFS, Polar, Van Allen은 전체 장면에 맞춘 썸네일에서 본체가 작게 보인다. 전용 표시 구도와 배율 검토가 남아 있다.", "",
        "## 권리 및 보정", "", "NASA는 공급처의 자료 이용 지침을 보존한다. 상표, 로고, 제3자 권리 및 보증 표현은 별도 검토한다.",
        "amvlab는 CC BY 4.0 출처표시, 라이선스 링크와 수정 이력 표시가 필요하다.",
        "SpaceTwin 자체 제작 4개 형상과 GOES-R 1개는 권리 재확인 전까지 공개 후보 색인에서 제외했다.",
        "Fab 원본은 아직 미획득이며 EULA 동의/계정 절차 및 Unreal/FBX 변환이 남아 있다. No-AI 표시도 보존했다.",
        "Terra 외부 텍스처, A320/GOES-R 법선과 색상, Jason/Jason-2/QuikSCAT UV 문제는 원본을 보존하고 보정했다.",
        "누락 texture/UV 면은 기본 색상을 사용한다. GOES-R의 정의되지 않은 법선은 조명용 대체값으로 처리했다.",
        "보정 후 형상 위치는 유지하지만 재질과 조명이 원본과 동일하다고 보장하지 않는다.", "",
        "## 목록", "", "| ID | 이름 | 분류 | 표시 성격 |", "|---|---|---|---|"]
    for x in items:
        lines.append(f"| {x['asset_id']} | {x['title']} | {x['category']} | {x['representation']} |")
    (LIBRARY / "readme.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    errors = validate_library(LIBRARY)["errors"]
    print(json.dumps({**summary, "errors": errors}, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
