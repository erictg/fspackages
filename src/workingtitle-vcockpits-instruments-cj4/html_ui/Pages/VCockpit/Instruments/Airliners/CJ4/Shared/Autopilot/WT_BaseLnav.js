class WT_BaseLnav {

    /**
     * Creates an instance of WT_BaseLnav.
     * @param {FlightPlanManager} fpm The flight plan manager to use with this instance. 
     */
    constructor(fpm) {
        this._fpm = fpm;

        this._flightPlanVersion = undefined;
        this._activeWaypointChanged = true;
        this._activeWaypointChangedflightPlanChanged = true;

        /**
         * The current active waypoint.
         * @type {WayPoint}
         */
        this._activeWaypoint = undefined;

        /**
         * The previous active waypoint.
         * @type {WayPoint}
         */
        this._previousWaypoint = undefined;

        this._planePos = undefined;
        this._groundSpeed = undefined;
        this._activeWaypointDist = undefined;
        this._previousWaypointDist = undefined;
        this._bearingToWaypoint = undefined;
        this._xtk = undefined;
        this._dtk = undefined;
        this._setHeading = undefined;

        this._onDiscontinuity = false;

        this._lnavDeactivated = true;

        /** Whether or not executing the calculated linear instructions is inhibited. */
        this._executeInhibited = false;
    }

    get waypoints() {
        return this._fpm.getAllWaypoints().slice(this._fpm.getActiveWaypointIndex());
    }

    /**
     * Run on first activation.
     */
    activate() {
        this.update();
    }

    /**
     * Update data if needed.
     */
    update() {

        //CAN LNAV EVEN RUN?
        this._activeWaypoint = this._fpm.getActiveWaypoint();
        this._previousWaypoint = this._fpm.getPreviousActiveWaypoint();
        const isLnavActive = SimVar.GetSimVarValue("L:WT_CJ4_LNAV_MODE", "number") == 0;
        const navModeActive = SimVar.GetSimVarValue("L:WT_CJ4_NAV_ON", "number") == 1;

        //CHECK IF DISCO/VECTORS
        if (this._onDiscontinuity) {
            if (!this._activeWaypoint.endsInDiscontinuity) {
                this._onDiscontinuity = false;
            }
            else if (navModeActive) {
                this.deactivate();
            }
        }

        if (!this._onDiscontinuity && this.waypoints.length > 0 && this._activeWaypoint && this._previousWaypoint) {
            this._lnavDeactivated = false;

            this._planePos = new LatLon(SimVar.GetSimVarValue("GPS POSITION LAT", "degree latitude"), SimVar.GetSimVarValue("GPS POSITION LON", "degree longitude"));

            //LNAV CAN RUN, UPDATE DATA
            this._groundSpeed = SimVar.GetSimVarValue("GPS GROUND SPEED", "knots");
            const planeHeading = SimVar.GetSimVarValue('PLANE HEADING DEGREES TRUE', 'Radians') * Avionics.Utils.RAD2DEG;

            this._activeWaypointDist = Avionics.Utils.computeGreatCircleDistance(new LatLong(this._planePos.lat, this._planePos.lon), this._activeWaypoint.infos.coordinates);
            this._previousWaypointDist = Avionics.Utils.computeGreatCircleDistance(new LatLong(this._planePos.lat, this._planePos.lon), this._previousWaypoint.infos.coordinates);
            this._bearingToWaypoint = Avionics.Utils.computeGreatCircleHeading(new LatLong(this._planePos.lat, this._planePos.lon), this._activeWaypoint.infos.coordinates);

            const prevWptPos = new LatLon(this._previousWaypoint.infos.coordinates.lat, this._previousWaypoint.infos.coordinates.long);
            const nextWptPos = new LatLon(this._activeWaypoint.infos.coordinates.lat, this._activeWaypoint.infos.coordinates.long);
            this._xtk = this._planePos.crossTrackDistanceTo(prevWptPos, nextWptPos) * (0.000539957); //meters to NM conversion
            this._dtk = Avionics.Utils.computeGreatCircleHeading(this._previousWaypoint.infos.coordinates, this._activeWaypoint.infos.coordinates);
            
            SimVar.SetSimVarValue("L:WT_CJ4_XTK", "number", this._xtk);
            SimVar.SetSimVarValue("L:WT_CJ4_DTK", "number", this._dtk);
            SimVar.SetSimVarValue("L:WT_CJ4_WPT_DISTANCE", "number", this._activeWaypointDist);

            const nextActiveWaypoint = this._fpm.getNextActiveWaypoint();

            //Remove heading instruction inhibition when near desired track
            if (Math.abs(Avionics.Utils.angleDiff(this._dtk, planeHeading)) < 10) {
                this._executeInhibited = false;
            }
            
            if (isLnavActive) {
                this._setHeading = this._dtk;

                const absInterceptAngle = Math.min(Math.pow(Math.abs(this._xtk) * 10, 1.35), 45);
                const interceptAngle = this._xtk < 0 ? absInterceptAngle : -1 * absInterceptAngle;
                
                let deltaAngle = Avionics.Utils.angleDiff(this._dtk, this._bearingToWaypoint);
                this._setHeading = (((this._dtk + interceptAngle) % 360) + 360) % 360;

                //CASE WHERE WE ARE PASSED THE WAYPOINT AND SHOULD SEQUENCE THE NEXT WPT
                if (!this._activeWaypoint.endsInDiscontinuity && Math.abs(deltaAngle) >= 90) {
                    this._setHeading = this._dtk;               
                    this._fpm.setActiveWaypointIndex(this._fpm.getActiveWaypointIndex() + 1);
                    
                    this._executeInhibited = false;
                    this.execute();
                    this._executeInhibited = true;

                    return;
                }
                //CASE WHERE INTERCEPT ANGLE IS NOT BIG ENOUGH AND INTERCEPT NEEDS TO BE SET TO BEARING
                else if (Math.abs(deltaAngle) > Math.abs(interceptAngle)) {
                    this._setHeading = this._bearingToWaypoint;
                }

                //TURN ANTICIPATION & TURN WAYPOINT SWITCHING
                const turnRadius = Math.pow(this._groundSpeed / 60, 2) / 9;
                const maxAnticipationDistance = SimVar.GetSimVarValue('AIRSPEED TRUE', 'Knots') < 350 ? 7: 10;

                if (this._activeWaypoint && !this._activeWaypoint.endsInDiscontinuity && nextActiveWaypoint && this._activeWaypointDist <= maxAnticipationDistance && this._groundSpeed < 700) {

                    let toCurrentFixHeading = Avionics.Utils.computeGreatCircleHeading(new LatLongAlt(this._planePos._lat, this._planePos._lon), this._activeWaypoint.infos.coordinates);
                    let toNextFixHeading = Avionics.Utils.computeGreatCircleHeading(this._activeWaypoint.infos.coordinates, nextActiveWaypoint.infos.coordinates);
                    
                    let nextFixTurnAngle = Avionics.Utils.angleDiff(planeHeading, toNextFixHeading);
                    let currentFixTurnAngle = Avionics.Utils.angleDiff(planeHeading, toCurrentFixHeading);

                    let enterBankDistance = (this._groundSpeed / 3600) * 4;

                    const getDistanceToActivate = turnAngle => Math.min((turnRadius * Math.tan((Math.abs(turnAngle) / 2) * (Math.PI / 180))) + enterBankDistance, maxAnticipationDistance);

                    let activateDistance = Math.max(getDistanceToActivate(nextFixTurnAngle), getDistanceToActivate(currentFixTurnAngle));
                    
                    if (this._activeWaypointDist <= activateDistance) { //TIME TO START TURN
                        this._setHeading = toNextFixHeading;
                        this._fpm.setActiveWaypointIndex(this._fpm.getActiveWaypointIndex() + 1);
                        
                        this._executeInhibited = false;                     
                        this.execute();
                        this._executeInhibited = true; //Prevent heading changes until turn is near completion
                        
                        return;
                    }
                }

                //DISCONTINUITIES
                if (this._activeWaypoint.endsInDiscontinuity && this._activeWaypointDist < 0.25) {
                    this._setHeading = this._dtk;
                    this.executeDiscontinuity();
                    return;
                }

                //NEAR WAYPOINT TRACKING
                if (navModeActive && this._activeWaypointDist < 0.5) { //WHEN NOT MUCH TURN, STOP CHASING DTK CLOSE TO WAYPOINT
                    this._setHeading = this._bearingToWaypoint;
                    this._executeInhibited = true;
                }
                this.execute();
            }
        }
        else {
            if (!this._lnavDeactivated) {
                this.deactivate();
            }
        }
    }

    /**
     * Execute.
     */
    execute() {
        if (!this._executeInhibited) {
            //ADD MAGVAR
            this._setHeading = GeoMath.correctMagvar(this._setHeading, SimVar.GetSimVarValue("MAGVAR", "degrees"));

            //ADD WIND CORRECTION
            const currWindDirection = Math.trunc(SimVar.GetSimVarValue("AMBIENT WIND DIRECTION", "degrees"));
            const currWindSpeed = Math.trunc(SimVar.GetSimVarValue("AMBIENT WIND VELOCITY", "knots"));
            const currCrosswind = Math.trunc(currWindSpeed * (Math.sin((this._setHeading * Math.PI / 180) - (currWindDirection * Math.PI / 180))));
            const windCorrection = 180 * Math.asin(currCrosswind / this._groundSpeed) / Math.PI;
            this._setHeading = (((this._setHeading + windCorrection) % 360) + 360) % 360;
            
            //SET HEADING
            SimVar.SetSimVarValue("L:WT_TEMP_SETHEADING", "number", this._setHeading);
            Coherent.call("HEADING_BUG_SET", 2, this._setHeading);
        }
    }

    /**
     * Execute Vectors
     */
    executeDiscontinuity() {
        if (!this._executeInhibited) {
            //ADD MAGVAR
            this._setHeading = GeoMath.correctMagvar(this._setHeading, SimVar.GetSimVarValue("MAGVAR", "degrees"));

            //SET HEADING AND CHANGE TO HEADING MODE
            Coherent.call("HEADING_BUG_SET", 2, this._setHeading);
            Coherent.call("HEADING_BUG_SET", 1, this._setHeading);
            SimVar.SetSimVarValue("K:HEADING_SLOT_INDEX_SET", "number", 1);
            SimVar.SetSimVarValue("L:WT_CJ4_HDG_ON", "number", 1);
            SimVar.SetSimVarValue("L:WT_CJ4_NAV_ON", "number", 0);
            SimVar.SetSimVarValue("L:WT_CJ4_XTK", "number", 0);
            SimVar.SetSimVarValue("L:WT_CJ4_DTK", "number", this._setHeading);
            SimVar.SetSimVarValue("L:WT_CJ4_WPT_DISTANCE", "number", 0);

            this._onDiscontinuity = true;
        }
    }

    /**
     * Run when deactivated.
     */
    deactivate() {
        SimVar.SetSimVarValue("K:HEADING_SLOT_INDEX_SET", "number", 1);
        SimVar.SetSimVarValue("L:WT_CJ4_HDG_ON", "number", 1);
        SimVar.SetSimVarValue("L:WT_CJ4_NAV_ON", "number", 0);
        SimVar.SetSimVarValue("L:WT_CJ4_XTK", "number", 0);
        SimVar.SetSimVarValue("L:WT_CJ4_DTK", "number", this._setHeading);
        SimVar.SetSimVarValue("L:WT_CJ4_WPT_DISTANCE", "number", 0);
        this._lnavDeactivated = true;
    }
}
