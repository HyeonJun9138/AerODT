"""Run with python -m user_application.apps.web_dashboard from the repository."""
import argparse
import uvicorn
from user_application.apps.web_dashboard.application import create_app, load_config


def main():
    parser = argparse.ArgumentParser(description="AeroDT Web Live Twin")
    parser.add_argument("--config")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--buildings", action="store_true", help="로컬 Cesium 인증으로 근접 3D 건물 표시")
    parser.add_argument("--opensky", action="store_true", help="로컬 인증정보로 실제 OpenSky 수집 활성화")
    parser.add_argument("--vworld", action="store_true", help="로컬 브이월드 키로 국내 영상·건물 자료 선택 가능")
    parser.add_argument("--saved-satellites", help="저장 GP .json.gz 사용, CelesTrak 네트워크 요청 비활성")
    parser.add_argument("--fixture-aircraft", action="store_true", help="명시적으로 표시된 시험 항공기 입력")
    parser.add_argument("--fixture-satellites", action="store_true", help="명시적으로 표시된 시험 위성 궤도 입력")
    parser.add_argument("--fixture-satellite-count", type=int, default=24)
    args = parser.parse_args()
    config = load_config(args.config)
    if args.saved_satellites:
        config['saved_satellites'] = args.saved_satellites
        config['celestrak_enabled'] = False
    if args.buildings:
        from user_application.apps.web_dashboard.credentials import configure_cesium
        configure_cesium()
        config['buildings_enabled'] = True
    if args.opensky:
        from user_application.apps.web_dashboard.credentials import configure_opensky
        configure_opensky()
        config['opensky_enabled'] = True
    if args.vworld:
        from user_application.apps.web_dashboard.credentials import configure_vworld
        configure_vworld()
        config['vworld_enabled'] = True
    if args.fixture_aircraft:
        config["fixture_mode"] = True
    if args.fixture_satellites:
        config["fixture_satellites"] = True
        config["fixture_satellite_count"] = args.fixture_satellite_count
    uvicorn.run(create_app(config), host=args.host or config["host"], port=args.port or config["port"], workers=1)


if __name__ == "__main__":
    main()
