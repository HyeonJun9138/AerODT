from digital_twin.simulation import manual_takeover as manual, manual_procedure
from test_manual_takeover import day

def test_chart_carries_assigned_route_in_travel_order_and_observed_ground_occupancy():
    e=day()
    try:
        identifier=next(iter(e.aircraft));a=e.aircraft[identifier]
        manual.hand_over(e,identifier)
        manual.place(e,identifier,latitude=a.latitude,longitude=a.longitude,altitude=a.altitude,airborne=False)
        assert manual.request(e,identifier,'departure')['state']=='granted'
        chart=manual_procedure.ground_chart(e,a,a.flight)
        phase=next(p for p in a.route.phases if p.stage=='gate_out')
        assert chart['vertiport']==a.flight['origin']
        assert chart['points']==[{'latitude_deg':p[0],'longitude_deg':p[1]} for p in phase.points]
        assert chart['taxi_granted']
        assert all(o['aircraft_id']!=identifier for o in chart['occupied'])
        for o in chart['occupied']:
            assert o['latitude_deg']==e.aircraft[o['aircraft_id']].latitude
        a.external['pose_received']-=10
        assert not manual_procedure.ground_chart(e,a,a.flight)['taxi_granted']
    finally:e.close()
