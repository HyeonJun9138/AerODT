# 0026: 사람 시각 자산 분류

사용자가 승객 탑승 모사의 준비로 사람 모델을 공유 라이브러리에 요청했다.
기존 asset metadata v1의 category에 people/civilian을 추가하고 렌더 카탈로그에는
kind=person으로 투영한다. 위성으로 잘못 분류하지 않는다. 기존 기체/위성 값은 유지한다.
이 분류는 시각 자산 재고일 뿐 runtime entity나 탑승 상태 계약을 추가하지 않는다.
첫 자산은 Kenney Blocky Characters 2.0 character-b (CC0)이며 원본 형상과
애니메이션은 유지하고 외부 PNG만 GLB에 포함했다. 인체 실측 크기는 검증하지 않았다.
