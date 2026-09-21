# Aircraft Camera Detection Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for isolated implementation tasks and review.

Goal: Selected aircraft opens a camera-only window; AI ON enables local flying-object YOLO and tracking.
Architecture: Reuse AirframeCamera and WindowWorkspace. Browser submits captured JPEG through bounded local API. Inference owns derived session tracks, never physical state.
Spec: project_support/docs/plans/2026_09_14_aircraft_camera_detection_design.md

## Constraints and ruling
User approved 2026-09-14. Work in current codex/visual-asset-library checkout to preserve the ongoing uncommitted web application used by the user; no unrelated staging or resets. No additional worktree or operating server termination without permission. Keep existing cockpit and simulation control behavior. Parent integrates frontend, independent worker owns detector and routes.

## Task 1: Model and local inference API
Files: ai_pnp/flying_object_detection.py, communication/web/camera_detection_routes.py, user_application/apps/web_dashboard/application.py, digital_twin/model_library/detection_models/flying_objects_v1, project_support/tests/web_live/test_camera_detection.py, project_support/docs/adr.
- [x] RED: invalid JPEG/size rejected, metadata preserved, no load before predict, isolated session trackers, one active inference, stale sequence rejected.
- [x] Implement GET /api/camera/model for status only; POST /api/camera/detect accepts JSON {session_id,entity_id,camera,frame_id,captured_at,width,height,image_base64}; response echoes metadata with detections [{box:[x1,y1,x2,y2],class_name,confidence,track_id}], inference_ms, model_id. DELETE /api/camera/session/{session_id} releases derived tracks without model reload. 576x288 JPEG, maximum 1 MB encoded and 1280x720 decoded. Limit sessions and expire idle sessions.
- [x] Safely acquire and verify specialized artifact and class mapping, record revision/license/hash. Use ONNX or restricted safe checkpoint conversion, never weights_only=False on downloaded checkpoint. Fail visibly if unavailable.
- [x] GREEN tests plus real inference evidence; no fabricated performance claim.

## Task 2: Camera window and latest-frame client
Files: user_application/web/aircraft_camera_panel.js, aircraft_camera_panel.css, camera_detection_session.js, app.js, index.html; digital_twin/visualization/web/airframe_camera.js; browser tests.
- [x] RED: rear accepted; default AI OFF; result identity gating on switch/off; no concurrent requests; singleton and cleanup.
- [x] Implement standalone singleton panel opened by explicit aircraft/UAM selections and single-flight selection. Reuse read-only model matrix. Compass-like direction controls; AI toggle; 576x288 image and matched overlay. Manage 440x440 window. Render only visible selected direction. Inference max 5 Hz and one request; paired image+boxes shown only under 1 second old.
- [x] GREEN targeted tests and actual browser camera selection, AI off/on, resize and close. Retain original cockpit rendering.

## Task 3: Integration and review
- [x] Run combined Python/Node tests; inspect real API and browser camera pixels; measure inference latency.
- [x] Independent review of implementation and source-truth bounds; fix findings and rerun.
- [x] CURRENT.md and HISTORY.jsonl record exact evidence and remaining limits. Request restart only if required to activate server changes; use verified server identity.

## Execution record
2026-09-14: Implementation complete in the existing checkout; no commit, merge, push or unrelated cleanup. Node targeted regressions185 PASS; isolated detector14 PASS; app API/audit21 PASS and1 dependency-specific skip (covered in detector environment). Full repository/native suite not claimed. Positive real-photo HTTP inference on final restarted server: initial4671ms, warm526ms, Airplane confidence0.6155 and repeat ID1. Browser UAM/aircraft selection, rear, compact right-top, AI ON436ms, OFF/minimize verified. Single-flight path covered by unit tests; full replay browser acceptance remains untested. Model source actual classes replace the model-card Background claim with Fixed-wing drone. Published model license and dependency conditions remain distinct.
