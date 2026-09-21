"""Read-only operational views shared by Simulation and Physical observations.

The caller owns the engine and serializes reads against its tick. This mixin
never advances it, commands a pilot, or owns a second runtime state.
"""
import math

from digital_twin.model_library import flight_plan, flight_schedule


def _segment_distance(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = dx*dx+dy*dy
    t = max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0
    return math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)


def marshaller_post(layout, gate, aircraft_radius):
    """Deterministic deck-local post outside swept taxi/stand/pad envelopes."""
    corners = layout.get("platform", {}).get("corners_m", [])
    if len(corners) != 4:
        return None
    # Work in the platform rectangle axes so rotated layouts stay on the deck.
    origin=corners[0]
    u=(corners[1][0]-origin[0], corners[1][1]-origin[1])
    v=(corners[3][0]-origin[0], corners[3][1]-origin[1])
    width,height=math.hypot(*u),math.hypot(*v)
    if min(width,height)<=2:
        return None
    u=tuple(x/width for x in u);v=tuple(x/height for x in v)
    def safe(p):
        delta=(p[0]-origin[0],p[1]-origin[1])
        x=sum(a*b for a,b in zip(delta,u));y=sum(a*b for a,b in zip(delta,v))
        if not (1<=x<=width-1 and 1<=y<=height-1):return False
        rounded=min(float(layout['platform'].get('corner_radius_m',0)),width/2,height/2)
        if rounded>1:
            cx=max(rounded,min(width-rounded,x));cy=max(rounded,min(height-rounded,y))
            if math.hypot(x-cx,y-cy)>rounded-1:return False
        for edge in layout.get('edges',[]):
            points=edge.get('points_m',[])
            clearance=max(aircraft_radius,float(edge.get('width_m',0))/2)+2
            if any(_segment_distance(p,a,b)<clearance for a,b in zip(points,points[1:])):return False
        for kind in ('gates','fatos','chargers','boarding_points'):
            for place in layout.get(kind,[]):
                r=max(aircraft_radius,float(place.get('radius_m',0)))+2 if kind=='gates' else float(place.get('safety_radius_m',place.get('radius_m',2)))+2
                if math.dist(p,place['center_m'])<r:return False
        return True
    center=gate['center_m']
    radius=max(float(gate.get('radius_m',6)),aircraft_radius)+3
    for distance in (radius,radius+4,radius+8):
        for i in range(24):
            angle=i*math.tau/24
            point=(center[0]+distance*math.cos(angle),center[1]+distance*math.sin(angle))
            if safe(point):return point
    return None


class ScenarioObservation:
    _DEPARTURE_PHASES = ("gate_out", "takeoff")
    _ARRIVAL_PHASES = ("landing", "gate_in", "charge")

    def state_for(self, aircraft):
        return self.engine._state(aircraft)

    def flight_detail_for(self, flight_id):
        return self.engine.flight_detail(flight_id)

    def aircraft(self, aircraft_id):
        """One airframe, whether it is flying or standing on a deck."""
        if self.engine is None:
            return None
        found = self.engine.aircraft.get(aircraft_id) or self.engine.aircraft.get(
            str(aircraft_id).split(":", 1)[-1])
        if found is None:
            return None
        state = self.state_for(found)
        detail = self.flight_detail_for(state["flight_id"]) if state["flight_id"] else None
        return {"state": state, "flight": (detail or {}).get("flight"),
                "clearance": (detail or {}).get("clearance"),
                "events": (detail or {}).get("events", []),
                "turnaround_ready_s": round(found.ready_s, 1),
                "completed": found.completed, "remaining": max(0, len(found.flights) - found.next_flight)}


    def passengers(self):
        """Everybody walking to or from an aircraft right now, and their path.

        Only the aircraft actually loading or unloading are in it, so the list
        is a handful even on a busy morning; the display draws the ones it can
        see and leaves the rest as a count.
        """
        if self.engine is None:
            return None
        now, walking, cabins = self.engine.time_s, [], []
        for aircraft in self.engine.aircraft.values():
            flow = self.engine._passenger_flow(aircraft, now)
            cabins.append({"aircraft_id":aircraft.aircraft_id, "on_board":(flow or {}).get("on_board",0)})
            if not flow or flow["phase"] == "aboard":
                continue
            unloading = aircraft.unloading
            schedule = (unloading or {}).get("schedule") if unloading else (
                aircraft.route.boarding if aircraft.route else None)
            if not schedule:
                continue
            walking.append({
                "aircraft_id": aircraft.aircraft_id, "flight_id": flow.get("flight_id")
                or (aircraft.flight or {}).get("flight_id") or (unloading or {}).get("flight_id"),
                "phase": flow["phase"], "vertiport": flow["vertiport"], "stand": flow["stand"],
                "elapsed_s": flow["elapsed_s"], "duration_s": flow["duration_s"],
                "count": flow["count"], "on_board": flow["on_board"],
                # People stand on the deck, not on the ground under it. The
                # engine has already resolved that height for the route, so the
                # display does not sample terrain to place a walk.
                "deck_m": round(self.engine._deck_height(flow["vertiport"]), 2)
                if flow.get("vertiport") else None,
                "walk": {"count": schedule["count"], "path": schedule["path"],
                         "distances_m": schedule["distances_m"], "walk_mps": schedule["walk_mps"],
                         "walk_s": schedule["walk_s"], "enter_s": schedule["enter_s"],
                         "release_s": schedule["release_s"], "duration_s": schedule["duration_s"],
                         "asset_id": schedule["asset_id"], "height_m": schedule["height_m"],
                         "door_side":schedule.get("door_side"),
                         "path_height_offsets_m":schedule.get("path_height_offsets_m"),
                         "datum": schedule.get("datum"), "alighting": flow["phase"] == "alighting"},
            })
        return {"schema_version": 1, "time_s": round(now, 1),
                "clock": flight_schedule.clock_text(now), "aircraft": walking, "cabins":cabins,
                "crew": self._ground_crew(now)}

    # The ground crew: who is out on the deck for an aircraft right now. A
    # marshaller stands off the stand and signals an aircraft taxiing to or
    # from it; a charging hand walks the cable from the cabinet to the port
    # once the aircraft is still on its stand, plugs in, and stays beside it.
    # Nothing here decides anything - the energy model says when the cable is
    # connected and the ground controller says when the aircraft moves - this
    # only says where a person would be while that happens.
    CREW_ASSET_ID = "kenney_blocky_person_q"
    CREW_HEIGHT_M = 1.75
    CABLE_WALK_S = 20.0        # cabinet to port, cable in hand
    PLUG_S = 6.0               # the plugging-in itself
    MARSHAL_RANGE_M = 60.0     # the marshaller signals an aircraft this close
    MARSHAL_STANDOFF_M = 3.0   # beyond the stand circle

    def _ground_crew(self, now):
        from digital_twin.simulation import scenario_energy
        crew = []
        engine = self.engine
        for aircraft in engine.aircraft.values():
            flight = aircraft.flight
            if aircraft.phase in ("gate_out", "gate_in") and flight:
                deck = flight["origin"] if aircraft.phase == "gate_out" else flight["destination"]
                stand = (aircraft.stand if aircraft.phase == "gate_out"
                         else (aircraft.clearance.stand if aircraft.clearance else None) or flight.get("arrival_stand"))
                layout = engine._layout(deck) if deck else None
                gate = next((g for g in (layout or {}).get("gates", ()) if g["id"] == stand), None)
                if not gate:
                    continue
                frame = layout["frame"]
                gate_lat, gate_lon = flight_plan._local_to_global(frame, *gate["center_m"])
                east = (aircraft.longitude - gate_lon) * 111320.0 * math.cos(math.radians(gate_lat))
                north = (aircraft.latitude - gate_lat) * 111320.0
                distance = math.hypot(east, north)
                # A fixed safe post beside the stand, never on the incoming ray.
                radius = max(engine._ground_radius(aircraft),
                             float(layout.get("dimensions", {}).get("vehicle_d_m", 14)) / 2)
                post = marshaller_post(layout, gate, radius)
                if post is None:
                    continue  # No safe place on this deck; do not draw a person in traffic.
                lat, lon = flight_plan._local_to_global(frame, *post)
                # Other aircraft (including manual taxi) can stray off the graph.
                # Keep the post fixed; suppress its visual if an actual footprint enters it.
                occupied = False
                for other in engine.aircraft.values():
                    if other.airborne:
                        continue
                    dx = (other.longitude-lon)*111320*math.cos(math.radians(lat))
                    dy = (other.latitude-lat)*111320
                    if math.hypot(dx, dy) < max(radius, engine._ground_radius(other))+2:
                        occupied = True
                        break
                if occupied:
                    continue
                bearing = math.degrees(math.atan2(
                    (aircraft.longitude-lon)*math.cos(math.radians(lat)), aircraft.latitude-lat)) % 360
                signalling = distance <= self.MARSHAL_RANGE_M and (aircraft.speed_mps > 0.1 or
                             aircraft.instruction.get("action") == "ground_wait")
                crew.append({"role": "marshaller", "aircraft_id": aircraft.aircraft_id,
                             "flight_id": flight["flight_id"], "vertiport": deck, "stand": stand,
                             "longitude": lon, "latitude": lat, "heading": round(bearing, 1),
                             "action": "signal" if signalling else "idle",
                             "deck_m": round(engine._deck_height(deck), 2),
                             "asset_id": self.CREW_ASSET_ID, "height_m": self.CREW_HEIGHT_M})
                continue
            energy = aircraft.energy
            if aircraft.phase != "parked" or energy.parked_at is None or aircraft.vertiport is None:
                continue
            if energy.charge_state not in ("connecting", "charging", "complete"):
                continue
            socket = scenario_energy._connection(engine, aircraft)
            if not socket:
                continue
            eligible = energy.parked_at + energy.profile["connect_delay_s"]
            if aircraft.unloading:
                eligible = max(eligible, aircraft.unloading["from_s"] + aircraft.unloading["duration_s"])
            # The port, on the side of the aircraft the cabinet is on, the way
            # the display draws the cable to it.
            heading = math.radians(aircraft.heading or 0.0)
            east_scale = 111320.0 * math.cos(math.radians(aircraft.latitude))
            dx = (socket["longitude_deg"] - aircraft.longitude) * east_scale
            dy = (socket["latitude_deg"] - aircraft.latitude) * 111320.0
            side = 1.0 if dx * math.cos(heading) - dy * math.sin(heading) >= 0 else -1.0
            right = side * socket["port_right_m"]
            port = (aircraft.longitude + math.cos(heading) * right / east_scale,
                    aircraft.latitude - math.sin(heading) * right / 111320.0)
            start = eligible - self.CABLE_WALK_S
            if energy.charge_state == "connecting":
                action = "walk" if now >= start else "wait"
            else:
                action = "plug" if now - eligible < self.PLUG_S else "idle"
            crew.append({"role": "charger", "aircraft_id": aircraft.aircraft_id,
                         "vertiport": aircraft.vertiport, "stand": aircraft.stand,
                         "charger_id": socket["charger_id"], "state": energy.charge_state,
                         "path": [[socket["longitude_deg"], socket["latitude_deg"]], [port[0], port[1]]],
                         "elapsed_s": round(now - start, 1), "walk_s": self.CABLE_WALK_S,
                         "action": action, "cable": action in ("walk", "plug", "idle"),
                         "deck_m": round(engine._deck_height(aircraft.vertiport), 2),
                         "asset_id": self.CREW_ASSET_ID, "height_m": self.CREW_HEIGHT_M})
        return crew


    def _movement(self, aircraft, vertiport_id):
        """Where this aircraft is going on this deck's surface, or None.

        The deck's own stages are the two ground runs and the two verticals.
        A gate is where it stands and a pad is where it leaves or arrives, so
        the movement is one of stand -> pad, pad -> stand, or a pad on its own.
        """
        phase, route, flight = aircraft.phase, aircraft.route, aircraft.flight
        if flight is None or route is None:
            return None
        departing = phase in self._DEPARTURE_PHASES
        arriving = phase in self._ARRIVAL_PHASES
        if not departing and not arriving:
            return None
        deck = flight["origin"] if departing else flight["destination"]
        if deck != vertiport_id:
            return None
        end = route.departure if departing else route.arrival
        fato = (end or {}).get("fato") or flight.get(
            "departure_fato" if departing else "arrival_fato")
        stand = (aircraft.stand if departing else (aircraft.clearance.stand if aircraft.clearance else None)) or (end or {}).get("gate") or flight.get(
            "departure_stand" if departing else "arrival_stand") or None
        places = {"gate_out": (stand, fato), "gate_in": (fato, stand),
                  "takeoff": (fato, None), "landing": (None, fato), "charge": (stand, stand)}
        origin, target = places.get(phase, (None, None))
        return {"aircraft_id": aircraft.aircraft_id,
                "flight_id": flight["flight_id"], "phase": phase,
                'instruction':dict(aircraft.instruction),
                'ground_waiting':self.state_for(aircraft)['ground_waiting'],
                'gate_assignment':self.engine._gate_assignment(aircraft),
                "direction": "departure" if departing else "arrival",
                "stand": stand, "fato": fato, "from": origin, "to": target,
                # The surface it is on right now: the pair a taxiway run joins,
                # or the pad it is standing on. The display marks its own layout
                # from this; the engine does not route along the ground itself.
                "on_ground": phase in ("gate_out", "gate_in"),
                "counterpart": flight["destination"] if departing else flight["origin"]}


    def vertiport(self, vertiport_id):
        """What one deck is doing: who is on it, who is coming, who is waiting."""
        if self.engine is None:
            return None
        standing, inbound, outbound, holding = [], [], [], []
        for aircraft in self.engine.aircraft.values():
            state = self.state_for(aircraft)
            if state["phase"] == "parked" and state["vertiport"] == vertiport_id:
                standing.append(state)
            elif state["destination"] == vertiport_id:
                (holding if state["holding"] else inbound).append(state)
            elif state["origin"] == vertiport_id and state["airborne"]:
                outbound.append(state)
        pads = {}
        for (vertiport, fato), timeline in self.engine.psu._pads.items():
            if vertiport == vertiport_id:
                pads[fato] = [{"from_s": round(start, 1), "to_s": round(end, 1),
                               "flight_id": flight, "kind": kind}
                              for start, end, flight, kind in timeline.slots][-8:]
        movements = [found for found in
                     (self._movement(aircraft, vertiport_id) for aircraft in self.engine.aircraft.values())
                     if found is not None]
        report = (self.engine.psu.resource_monitor.report(vertiport_id, self.engine.time_s)
                  if self.engine.psu.resource_monitor is not None else None)
        return {"vertiport_id": vertiport_id, "clock": flight_schedule.clock_text(self.engine.time_s),
                # The pad bookings below are in the day's own seconds, so the
                # display needs the same clock to say which of them is now.
                "time_s": round(self.engine.time_s, 1),
                "standing": standing, "inbound": inbound, "outbound": outbound, "holding": holding,
                "movements": movements,
                "pads": pads,
                "stands": {stand: flight for (place, stand), flight
                           in self.engine.psu._stands.by_stand.items() if place == vertiport_id},
                "stand_reservations": {stand:flight for (place,stand),flight
                           in self.engine.psu._stands.reserved.items() if place==vertiport_id},
                "resource_report": report.as_dict() if report else None}


    def vertiport_summary(self):
        """Every deck at once: what is on it, coming to it and waiting for it.

        The per-deck view answers one vertiport at a time, which is right for its
        operator and wrong for the PSU, who is watching all of them. Asking for
        eighteen decks every few seconds to build this in the browser would be
        eighteen requests for one screen; this is the same answer in one.
        """
        if self.engine is None:
            return None
        decks = {}

        def row(vertiport_id):
            return decks.setdefault(vertiport_id, {"vertiport_id": vertiport_id, "standing": 0,
                                                   "inbound": 0, "outbound": 0, "holding": 0,
                                                   "moving": 0, "stands_taken": [], "pads_busy": []})

        for aircraft in self.engine.aircraft.values():
            state = self.state_for(aircraft)
            if state["phase"] == "parked" and state["vertiport"]:
                found = row(state["vertiport"])
                found["standing"] += 1
            elif state["destination"]:
                found = row(state["destination"])
                found["holding" if state["holding"] else "inbound"] += 1
            elif state["origin"] and state["airborne"]:
                row(state["origin"])["outbound"] += 1
            # Whichever deck's surface it is on is also that deck's business.
            for place in (aircraft.flight or {}).get("origin"), (aircraft.flight or {}).get("destination"):
                if place and self._movement(aircraft, place):
                    row(place)["moving"] += 1
        for (vertiport,stand),_aircraft in self.engine.psu._stands.by_stand.items():
            row(vertiport)['stands_taken'].append(stand)
        now = self.engine.time_s
        for (vertiport, fato), timeline in self.engine.psu._pads.items():
            if any(start <= now < end for start, end, _flight, _kind in timeline.slots):
                row(vertiport)["pads_busy"].append(fato)
        for found in decks.values():
            found["stands_taken"] = sorted(set(found["stands_taken"]))
            found["pads_busy"] = sorted(set(found["pads_busy"]))
        return {"clock": flight_schedule.clock_text(self.engine.time_s),
                "time_s": self.engine.time_s,
                "arrivals": [dict(c.as_dict(), aircraft_id=a.aircraft_id, phase=a.phase,
                                  instruction=dict(a.instruction))
                             for a in self.engine.aircraft.values()
                             if a.flight and (c := a.clearance) and c.released_s is None],
                "vertiports": [decks[key] for key in sorted(decks)]}


    def pilot_operations(self):
        if self.engine is None:
            return {"schema_version": 1, "loaded": False, "aircraft": []}
        return {"schema_version": 1, "loaded": True, "state": self.state,
                "time_s": self.engine.time_s, "clock": flight_schedule.clock_text(self.engine.time_s),
                "aircraft": [self.state_for(a) for a in self.engine.aircraft.values()
                             if a.flight is not None],
                "policy": self.engine.policy['pilot']}


