# ADR 0030: 단일 비행의 외형 선택과 공통 AirTaxi 동역학

상태: 적용 (2026-09-10)

## 결정

- 비행 계획은 단일 비행과 다중 비행 탭으로 나눈다. 다중 비행은 준비 중임을 표시하며 실행 API를 호출하지 않는다.
- options 응답에 `visual_models`를 추가하고 요청의 선택 필드 `visual_asset_id`를 허용한다. 미지정은 기존 AirTaxi, 허용 목록 밖 값은 거절한다. 저장 계획의 `aircraft.asset_id`에 선택을 보존한다.
- `aircraft.id`, 모델 파라미터, native runner, FastPhysics와 SimpleFlight는 모두 AirTaxi로 유지한다. 기종별 실제 성능으로 오인하지 않도록 UI에 공통 동역학을 표시한다. 기존 저장 실행은 소급 변경하지 않는다.
- 원본 `model.glb`와 원본 메타데이터 해시는 유지한다. 선택 기체의 `flight_model.glb`는 비행 전용 파생 자산이며 `flight_visual`에 URI, 원본/파생 해시, 회전 부품과 변경 근거를 기록한다. 일반 라이브러리는 원본을 계속 제공한다.
- 로터마다 스핀 축, 힌지마다 축/방향/영점 오프셋을 지정할 수 있다. 기존 문자열 노드 목록은 호환한다. 힌지 부모와 로터 자식 노드를 분리하여 로터가 힌지를 중심으로 이동하면서 자기 축으로 회전한다. 매 프레임 원래 행렬에서 계산하므로 되감기와 역전환에 누적 오차가 없다.
- Joby 전방 4개는 전방, 후방 2개는 후방으로 회전한다. KP-2A는 전방 조립체만 전환한다. X-57은 날개 끝 2개만 가상 VTOL 전환한다. EVTOL은 원본 순항 자세에서 수직 자세로 복귀한다.

## 자산 처리와 한계

- X-57은 원래 VTOL 항공기가 아니다. 사용자가 요청한 틸트는 가상 외형이며 실제 항공기 구현이라고 표시하지 않는다. [NASA 개요](https://www.nasa.gov/centers-and-facilities/armstrong/x-57-maxwell/)의 고정익 구성을 참고한다. 원본 약 362만 정점을 약 4.9만으로 줄이고 정점 법선을 다시 생성했다. 인치 단위로 추정한 원본 좌표에 0.0254를 적용했으며 제조사 도면 치수 검증은 아니다.
- KP-2A의 실제 export rest skin pose를 정적 메시로 굽고 전방 틸트 조립체를 별도 부모에 묶는다. 동체와 로터를 중복 스키닝하지 않는다.
- EVTOL의 크기는 검증되지 않은 원본 스케일을 유지한다. Cesium에서 컴파일 실패하는 원본의 부가 재질 확장은 비행용 모델에서 제거하고 기본 색 텍스처/PBR을 유지한다.
- 얇은 로터의 뒷면이 사라지지 않게 양면 재질을 사용한다. 실제 구조 간섭, 기종별 안전 간격, 객실 문/좌석 및 정확한 승객 접근 위치는 검증 범위 밖이다.
- 이 변경은 웹 시각화와 계획 선택에 한정된다. 실제 Unreal UAM 검증을 대신하지 않는다.

## 검증

계획/옵션/저장 API 회귀, 공통 native waypoint 동일성, 실제 GLB 계층을 사용하는 0/45/90도 및 역순 행렬 시험, Khronos 검증과 독립 Cesium 화면 확인을 사용한다. 실행 결과와 잔여 제한은 개발 로그에 별도로 기록한다.

X-57 배율 참고: [NASA Mod III/IV 공력 보고서](https://ntrs.nasa.gov/api/citations/20250001494/downloads/NASATM3-X57mod3poweronv13.pdf?attachment=true)는 날개폭을 379.47 inches로 설명한다. 원본 메시의 날개폭 약 379.46 좌표 단위와의 대응을 근거로 인치→미터 환산을 적용했다. 다른 부분의 도면 일치나 새 VTOL 구조의 안전성을 보증하지 않는다.

## KP2 rear lift-prop display policy (2026-09-10)

Optional rotor-node `stop_at_tilt_deg` freezes that node at its current spin phase when sample tilt reaches the threshold. Missing values preserve continuous rotation. KP2 original and flight visual metadata apply 85 degrees to the two rear PropellerB nodes only, matching the fixed-wing display threshold. Below the threshold they resume from the held phase. This is a user-requested visualization policy, not a manufacturer RPM claim or a change to AirTaxi dynamics/actuator forces. Existing catalog consumers may ignore the additive field.

## Flight presentation normalization (2026-09-10)

The user requested AirTaxi-like sizes rather than manufacturer scale for KP2, Joby and AMVLab EVTOL. Derived GLBs now uniformly match the source AirTaxi maximum extent (7.351877 m) and keep their lowest point at zero. Acquired model.glb files are untouched. Joby keeps all six tilt assemblies, with front disc centers placed over existing pod-tip hinges and short display necks joining them. White fuselage and dark window materials reuse existing surface assignments. Six separate deflected wing control-surface islands are rigidly aligned to neighboring wing rest planes. These are display approximations, not verified manufacturer dimensions, linkage kinematics, or physics.

## X-57 전방 소형 프롭 표시 정책 (2026-09-10)

`flight_visual.rotors.nodes[].start_at_tilt_deg`는 선택적 표시 전용 필드다. 생략 시 기존처럼 모든 틸트 구간에서 회전하며, 지정 시 해당 각도 이상에서만 회전 위상을 진행한다. 정지 중 위상은 보존하고 재진입 때 이어서 회전한다. 기존 `stop_at_tilt_deg`와 함께 사용할 수 있다. 동역학이나 actuator 출력을 변경하지 않는다.

X-57 파생 외형은 전방 소형 프롭 12개를 85도 이상에서 회전하도록 한다. 실제 X-57 고양력 프로펠러의 운용 재현이 아니라 사용자가 요청한 고정익 구간의 시각 효과다. 원본 GLB는 보존하며 흰색 외장과 합성 창문 재질을 비행용 GLB에만 적용한다.

## KP2 decal preservation (2026-09-10)

The acquired Unreal Blueprint carries KADA/VIBUM decals outside MeshComponent. Extract original PNGs and component-template transforms without spawning or saving source actors. The derived flight build clips painted-surface triangles against each composed decal volume, maps Unreal decal Z/Y UVs, and offsets the alpha surface 1 mm. Original source GLB bytes remain untouched; original PNG bytes and placement are retained under the asset decals directory. No invented marks or placement are added. Regeneration must retain these surfaces and the rear-rotor display policy.

## UAM 조종면의 자세 기반 시각화 (2026-09-10)

현재 5종 UAM 표시 범위에서 Joby 8개, KP2 4개, AMVLab EVTOL 4개, X-57 5개의 날개/꼬리 조종면을 분리한다. AirTaxi는 독립된 일반 조종면을 추가하지 않고 기존 로터/틸트를 유지한다. 원본 GLB는 변경하지 않는다.

비행용 `rotors.control_surfaces`에 `source: attitude_proxy_not_actuator_telemetry` 및 `nodes` 목록을 기록한다. 노드의 `axis`는 해당 부모 좌표의 힌지 방향, `mix`는 roll/pitch/yaw 표시 명령의 부호와 혼합 비율, `limit_deg`는 표시 각도 제한이다. 기존 rotors/spin/tilt 노드와 소유권을 분리한다. 이 필드는 외부 비행 제어 wire schema가 아니라 시각 자산의 선택적 확장이다.

기록에 있는 roll/pitch/heading과 이웃 샘플 간 회전 속도로 작은 표시 편향을 계산한다. 실제 조종면 actuator 출력은 현재 재생 데이터에 없으므로 제어 명령 재현으로 표현하지 않는다. 속도와 틸트에 따라 효과를 억제하고 지상/호버에서는 중립으로 둔다. 현재 상태나 물리 엔진은 수정하지 않는다. 원행렬에서 매번 계산하며 재생 속도/정지/되감기에 따라 위상이 누적되지 않는다. 실제 native roll은 기록에서 화면 자세로 전달한다.

현재 힌지선과 조종면 경계는 외형에서 추정한 표시 모델이다. 제조사 공력 계수, 링크 구조, 조종면 간섭, 제어기 튜닝 또는 실제 항공기의 actuator 검증은 포함하지 않는다.

### User livery layout override (2026-09-10)

Original placement is retained separately from display_layout.json. The user requested substantially larger side marks below the canopy and two horizontal marks above. The display build targets painted body sides and upward body/wing surfaces only; source textures are unchanged. Four bounded overlay patches use 296 triangles. This replaces the earlier source-placement-only policy for the derived flight model, not the acquired source.
