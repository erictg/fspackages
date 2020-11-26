class WT_Trip_Planning_Input_Data {
    constructor() {
        this.departureTime = 0;
        this.groundSpeed = 100;
        this.fuelFlow = 1;
        this.fuelOnBoard = 30;
        this.calibratedAirspeed = 0;
        this.indicatedAltitude = 0;
        this.pressure = 29.92;
        this.totalAirTemperature = 20;
    }
    update(dt) {

    }
}

class WT_Trip_Planning_Auto_Input_Data extends WT_Trip_Planning_Input_Data {
    /**
     * @param {WT_Clock} clock 
     * @param {WT_Barometric_Pressure} barometricPressure 
     */
    constructor(clock, barometricPressure) {
        super();
        this.clock = clock;
        this.barometricPressure = barometricPressure;
    }
    update(dt) {
        this.departureTime = this.clock.localTime.value;
        this.calibratedAirspeed = Simplane.getIndicatedSpeed();
        this.fuelFlow = parseFloat(SimVar.GetSimVarValue("ENG FUEL FLOW GPH:1", "gallons per hour"));
        this.fuelOnBoard = parseFloat(SimVar.GetSimVarValue("FUEL TOTAL QUANTITY:1", "gallon"));
        this.groundSpeed = parseFloat(SimVar.GetSimVarValue("GPS GROUND SPEED", "knots"));
        this.indicatedAltitude = parseFloat(SimVar.GetSimVarValue("INDICATED ALTITUDE:1", "feet"));
        this.pressure = this.barometricPressure.getPressure();
        this.totalAirTemperature = parseFloat(SimVar.GetSimVarValue("AMBIENT TEMPERATURE", "celsius"));
    }
}

class WT_Trip_Planning_Model {
    /**
     * @param {WT_Clock} clock 
     * @param {WT_Barometric_Pressure} barometricPressure 
     * @param {FlightPlanManager} flightPlanManager
     */
    constructor(clock, barometricPressure, flightPlanManager) {
        this.clock = clock;
        this.barometricPressure = barometricPressure;
        this.flightPlanManager = flightPlanManager;

        this.tripStats = {
            track: new Subject(0),
            distance: new Subject(0),
            ete: new Subject(0),
            eta: new Subject(0),
            esa: new Subject(0),
            sunrise: new Subject(null),
            sunset: new Subject(null),
        };
        this.fuelStats = {
            efficiency: new Subject(0),
            totalEndurance: new Subject(0),
            remainingFuel: new Subject(0),
            remainingEndurance: new Subject(0),
            fuelRequired: new Subject(0),
            totalRange: new Subject(0),
        };
        this.otherStats = {
            densityAltitude: new Subject(0),
            trueAirspeed: new Subject(0),
        };
        this.mode = new Subject("Auto");
        this.waypointMode = new Subject("WPTS");
        this.manualInputData = new WT_Trip_Planning_Input_Data();
        this.autoInputData = new WT_Trip_Planning_Auto_Input_Data(clock, barometricPressure);
        this.inputData = null;
        this.numLegs = new Subject(0);
        this.selectedLeg = new Subject(null);
        this.positionWaypoint = {
            ident: "P.Pos",
            infos: {
                coordinates: this.getPlaneCoordinates()
            }
        };

        this.updateTimer = 0;

        this.manualWaypoints = {
            to: new Subject(null),
            from: new Subject(this.getPositionWaypoint()),
        }
        this.legWaypoints = {
            to: new Subject(null),
            from: new Subject(null),
        };

        this.mode.subscribe(mode => {
            switch (mode) {
                case "Auto":
                    this.inputData = this.autoInputData;
                    break;
                case "Manual":
                    this.inputData = this.manualInputData;
                    this.manualInputData.departureTime = this.manualInputData.departureTime;
                    break;
            }
        });

        this.onInputDataChanged = new WT_Event();
    }
    /**
     * @param {WT_Trip_Planning_Input_Data} inputData 
     */
    calculateTripStatistics(totalDistance, legDistance, dtk, inputData) {
        const groundSpeed = Math.max(1, inputData.groundSpeed);
        const fuelFlow = Math.max(0.1, inputData.fuelFlow);
        const legEteHours = legDistance / groundSpeed;
        const legEteSeconds = legEteHours * 3600;
        const totalEteHours = totalDistance / groundSpeed;
        const totalEteSeconds = totalEteHours * 3600;
        const enduranceHours = inputData.fuelOnBoard / fuelFlow;
        const enduranceSeconds = enduranceHours * 3600;

        function interpolate(value, to) {
            if (value.value === null) {
                value.value = to;
                return;
            }
            value.value = value.value + (to - value.value) / 5;
        }

        // Trip stats
        const tripStats = this.tripStats;
        if (totalDistance > 0) {
            tripStats.distance.value = legDistance;
            tripStats.track.value = dtk;
            interpolate(tripStats.ete, legEteSeconds);
            interpolate(tripStats.eta, inputData.departureTime + totalEteSeconds);
        } else {
            tripStats.distance.value = null;
            tripStats.ete.value = null;
            tripStats.eta.value = null;
            tripStats.track.value = null;
        }
        tripStats.sunrise.value = this.clock.getSunrise();
        tripStats.sunset.value = this.clock.getSunset();

        // Fuel stats
        const fuelStats = this.fuelStats;
        interpolate(fuelStats.efficiency, inputData.groundSpeed / fuelFlow);
        interpolate(fuelStats.totalEndurance, enduranceSeconds);
        interpolate(fuelStats.remainingFuel, inputData.fuelOnBoard - fuelFlow * totalEteHours);
        interpolate(fuelStats.remainingEndurance, Math.max(0, enduranceSeconds - totalEteSeconds));
        interpolate(fuelStats.fuelRequired, fuelFlow * totalEteHours);
        interpolate(fuelStats.totalRange, inputData.groundSpeed * enduranceHours);
    }
    calculateOtherStats(inputData) {
        // http://www.indoavis.co.id/main/tas.html
        const otherStats = this.otherStats;
        let xx = inputData.pressure / 29.92126;
        const pressureAltitude = inputData.indicatedAltitude + 145442.2 * (1 - Math.pow(xx, 0.190261));
        const lapserate = 0.0019812;
        const tempcorr = 273.15;
        const stdtemp0 = 288.15;
        const stdtemp = stdtemp0 - pressureAltitude * lapserate;
        const Tratio = stdtemp / lapserate;
        xx = stdtemp / (inputData.totalAirTemperature + tempcorr);
        const densityAltitude = pressureAltitude + Tratio * (1 - Math.pow(xx, 0.234969));
        otherStats.densityAltitude.value = densityAltitude;
        const aa = densityAltitude * lapserate;
        const bb = stdtemp0 - aa;
        const cc = bb / stdtemp0;
        const cc1 = 1 / 0.234969;
        let dd = Math.pow(cc, cc1);
        dd = Math.pow(dd, .5);
        const ee = 1 / dd;
        const ff = ee * inputData.calibratedAirspeed;
        otherStats.trueAirspeed.value = ff;
    }
    getPlaneCoordinates() {
        const lat = SimVar.GetSimVarValue("PLANE LATITUDE", "degree latitude");
        const long = SimVar.GetSimVarValue("PLANE LONGITUDE", "degree longitude");
        return new LatLong(lat, long);
    }
    getPositionWaypoint() {
        return this.positionWaypoint;
    }
    getTotalDistance(waypoints) {
        return waypoints.reduce((distance, waypoint, index, waypoints) =>
            index > 0 ? (distance + Avionics.Utils.computeDistance(waypoint.infos.coordinates, waypoints[index - 1].infos.coordinates)) : 0,
            0);
    }
    getLegDistance(waypoints) {
        if (this.mode == "Auto") {
            return this.getTotalDistance(waypoints);
        } else {
            return Avionics.Utils.computeDistance(waypoints[waypoints.length - 2].infos.coordinates, waypoints[waypoints.length - 1].infos.coordinates);
        }
    }
    getWaypoints() {
        switch (this.waypointMode.value) {
            case "FPL": {
                const waypoints = this.flightPlanManager.getWaypoints();
                this.numLegs.value = waypoints.length;
                if (this.selectedLeg.value === null) {
                    return waypoints;
                } else {
                    if (this.selectedLeg.value < waypoints.length && this.selectedLeg.value > 0) {
                        if (this.mode.value == "Auto") {
                            return [this.getPositionWaypoint(), waypoints[this.selectedLeg.value]];
                        } else {
                            return [waypoints[this.selectedLeg.value - 1], waypoints[this.selectedLeg.value]];
                        }
                    } else {
                        return [];
                    }
                }
                break;
            }
            case "WPTS": {
                if (this.manualWaypoints.from.value && this.manualWaypoints.to.value) {
                    return [this.manualWaypoints.from.value, this.manualWaypoints.to.value];
                }
                return [];
            }
        }
    }
    update(dt) {
        this.updateTimer += dt;
        this.positionWaypoint.infos.coordinates = this.getPlaneCoordinates();
        if (this.updateTimer > 100) {
            const waypoints = this.getWaypoints();
            this.inputData.update(dt);
            if (waypoints.length > 1) {
                const totalDistance = this.getTotalDistance(waypoints);
                const legDistance = this.getLegDistance(waypoints);
                const dtk = Avionics.Utils.computeGreatCircleHeading(waypoints[waypoints.length - 2].infos.coordinates, waypoints[waypoints.length - 1].infos.coordinates);
                this.calculateTripStatistics(totalDistance, legDistance, dtk, this.inputData);
                if (this.isFlightPlanMode()) {
                    if (this.isAutoMode()) {
                        this.legWaypoints.from.value = waypoints[0].ident;
                    } else {
                        if (this.selectedLeg.value === null) {
                            this.legWaypoints.from.value = waypoints[0].ident;
                        } else {
                            this.legWaypoints.from.value = waypoints[waypoints.length - 2].ident;
                        }
                    }
                }
                this.legWaypoints.to.value = waypoints[waypoints.length - 1].ident;
            }
            if (this.isWaypointsMode()) {
                this.legWaypoints.from.value = this.manualWaypoints.from.value ? this.manualWaypoints.from.value.ident : null;
                this.legWaypoints.to.value = this.manualWaypoints.to.value ? this.manualWaypoints.to.value.ident : null;
            }
            this.calculateOtherStats(this.inputData);
            this.updateTimer = 0;
        }
    }
    setMode(mode) {
        this.mode.value = mode;
    }
    setWaypointMode(mode) {
        this.waypointMode.value = mode;
    }
    selectLeg(leg) {
        this.selectedLeg.value = leg;
    }
    /**
     * @param {WayPoint} waypoint 
     */
    setFromWaypoint(waypoint) {
        this.manualWaypoints.from.value = waypoint;
    }
    /**
     * @param {WayPoint} waypoint 
     */
    setToWaypoint(waypoint) {
        this.manualWaypoints.to.value = waypoint;
    }
    isFlightPlanMode() {
        return this.waypointMode.value == "FPL";
    }
    isWaypointsMode() {
        return this.waypointMode.value == "WPTS";
    }
    isManualMode() {
        return this.mode.value == "Manual";
    }
    isAutoMode() {
        return this.mode.value == "Auto";
    }
}

class WT_Trip_Planning_Menu extends WT_Soft_Key_Menu {
    /**
     * @param {WT_Trip_Planning_Model} model 
     */
    constructor(model) {
        super(true);

        const buttons = {
            auto: new WT_Soft_Key("AUTO", () => model.setMode("Auto")),
            manual: new WT_Soft_Key("MANUAL", () => model.setMode("Manual")),
            flightPlan: new WT_Soft_Key("FPL", () => model.setWaypointMode("FPL")),
            waypoints: new WT_Soft_Key("WPTS", () => model.setWaypointMode("WPTS")),
        }

        this.addSoftKey(5, buttons.auto);
        this.addSoftKey(6, buttons.manual);

        this.addSoftKey(8, buttons.flightPlan);
        this.addSoftKey(9, buttons.waypoints);

        model.mode.subscribe(mode => {
            buttons.auto.selected = mode == "Auto";
            buttons.manual.selected = mode == "Manual";
        });

        model.waypointMode.subscribe(mode => {
            buttons.waypoints.selected = mode == "WPTS";
            buttons.flightPlan.selected = mode == "FPL";
        });
    }
}

class WT_Trip_Planning_View extends WT_HTML_View {
    /**
     * @param {WT_MFD_Soft_Key_Menu_Handler} softKeyMenuHandler 
     * @param {WT_Show_New_Waypoint_Handler} showWaypointSelector 
     * @param {MapInstrument} map 
     */
    constructor(softKeyMenuHandler, showWaypointSelector, map) {
        super();
        this.softKeyMenuHandler = softKeyMenuHandler;
        this.showWaypointSelector = showWaypointSelector;
        this.map = map;

        this.inputLayer = new Selectables_Input_Layer(new Selectables_Input_Layer_Dynamic_Source(this));
    }
    connectedCallback() {
        if (this.initialised)
            return;
        this.initialised = true;

        const template = document.getElementById('template-trip-planning-page');
        this.appendChild(template.content.cloneNode(true));
        super.connectedCallback();
    }
    formatTime(v) {
        const hours = Math.floor(v / 3600);
        const minutes = Math.floor((v % 3600) / 60);
        return `${hours.toFixed(0).padStart(2, "0")}:${minutes.toFixed(0).padStart(2, "0")}`;
    }
    /**
     * @param {WT_Trip_Planning_Model} model 
     */
    setModel(model) {
        this.model = model;
        this.softKeyMenu = new WT_Trip_Planning_Menu(model);

        model.tripStats.distance.subscribe(value => this.elements.dis.innerHTML = value !== null ? `${value.toFixed(1)}<span class="units">NM</span>` : ``);
        model.tripStats.ete.subscribe(value => this.elements.ete.innerHTML = value !== null ? this.formatTime(value) : ``);
        model.tripStats.eta.subscribe(value => this.elements.eta.innerHTML = value !== null ? this.formatTime(value) : ``);
        model.tripStats.track.subscribe(value => this.elements.dtk.innerHTML = value !== null ? `${value.toFixed(0)}°` : ``);
        model.tripStats.sunrise.subscribe(date => this.elements.sunrise.textContent = date !== null ? `${date.getHours().toFixed(0).padStart(2, "0")}:${date.getMinutes().toFixed(0).padStart(2, "0")}` : `__:__`);
        model.tripStats.sunset.subscribe(date => this.elements.sunset.textContent = date !== null ? `${date.getHours().toFixed(0).padStart(2, "0")}:${date.getMinutes().toFixed(0).padStart(2, "0")}` : `__:__`);

        model.fuelStats.efficiency.subscribe(efficiency => this.elements.efficiency.textContent = efficiency.toFixed(1));
        model.fuelStats.fuelRequired.subscribe(fuelRequired => this.elements.fuelRequired.textContent = fuelRequired.toFixed(1));
        model.fuelStats.remainingEndurance.subscribe(remainingEndurance => this.elements.remainingEndurance.textContent = this.formatTime(remainingEndurance));
        model.fuelStats.remainingFuel.subscribe(remainingFuel => this.elements.remainingFuel.textContent = remainingFuel.toFixed(1));
        model.fuelStats.totalEndurance.subscribe(totalEndurance => this.elements.totalEndurance.textContent = this.formatTime(totalEndurance));
        model.fuelStats.totalRange.subscribe(totalRange => this.elements.totalRange.textContent = totalRange.toFixed(1));

        model.otherStats.densityAltitude.subscribe(altitude => this.elements.densityAltitude.textContent = altitude.toFixed(0));
        model.otherStats.trueAirspeed.subscribe(speed => this.elements.trueAirspeed.textContent = speed.toFixed(0));

        model.mode.subscribe(mode => this.elements.pageMode.textContent = mode);

        model.legWaypoints.from.subscribe(waypoint => {
            this.elements.fromWaypoint.textContent = waypoint ? waypoint : "_____";
        });
        model.legWaypoints.to.subscribe(waypoint => {
            this.elements.toWaypoint.textContent = waypoint ? waypoint : "_____";
        });

        model.waypointMode.subscribe(mode => {
            DOMUtilities.ToggleAttribute(this.elements.flightPlanSelector, "disabled", mode == "WPTS");
            DOMUtilities.ToggleAttribute(this.elements.legSelector, "disabled", mode == "WPTS");
            DOMUtilities.ToggleAttribute(this.elements.fromWaypoint, "disabled", mode == "FPL");
            DOMUtilities.ToggleAttribute(this.elements.toWaypoint, "disabled", mode == "FPL");
            this.inputLayer.refreshSelected();
        });

        model.numLegs.subscribe(num => {
            this.elements.legSelector.clearOptions();
            this.elements.legSelector.addOption("rem", "REM");
            for (let i = 0; i < num - 1; i++) {
                this.elements.legSelector.addOption(i + 1, (i + 1).toFixed(0).padStart(2, "0"));
            }
        });

        model.selectedLeg.subscribe(leg => {
            if (leg === null) {
                this.elements.legSelector.value = "rem";
            } else {
                this.elements.legSelector.value = leg;
            }
        })

        model.mode.subscribe(mode => {
            const isAutoMode = mode == "Auto";
            [
                this.elements.depTime, this.elements.groundSpeed, this.elements.fuelFlow, this.elements.fuelOnBoard,
                this.elements.calibratedAirspeed, this.elements.indicatedAltitude, this.elements.pressure, this.elements.totalAirTemperature,
            ].forEach(element => DOMUtilities.ToggleAttribute(element, "disabled", isAutoMode));
            this.inputLayer.refreshSelected();
        });
    }
    update(dt) {
        this.model.update(dt);

        this.elements.depTime.value = this.model.inputData.departureTime;
        this.elements.groundSpeed.value = this.model.inputData.groundSpeed;
        this.elements.fuelFlow.value = this.model.inputData.fuelFlow;
        this.elements.fuelOnBoard.value = this.model.inputData.fuelOnBoard;

        this.elements.calibratedAirspeed.value = this.model.inputData.calibratedAirspeed;
        this.elements.indicatedAltitude.value = this.model.inputData.indicatedAltitude;
        this.elements.pressure.value = this.model.inputData.pressure;
        this.elements.totalAirTemperature.value = this.model.inputData.totalAirTemperature;
    }
    setDepartureTime(departureTime) {
        if (this.model.isManualMode())
            this.model.manualInputData.departureTime = departureTime;
    }
    setGroundSpeed(groundSpeed) {
        if (this.model.isManualMode())
            this.model.manualInputData.groundSpeed = groundSpeed;
    }
    setFuelOnBoard(fuelOnBoard) {
        if (this.model.isManualMode())
            this.model.manualInputData.fuelOnBoard = fuelOnBoard;
    }
    setFuelFlow(fuelFlow) {
        if (this.model.isManualMode())
            this.model.manualInputData.fuelFlow = fuelFlow;
    }
    setCalibratedAirspeed(calibratedAirspeed) {
        if (this.model.isManualMode())
            this.model.manualInputData.calibratedAirspeed = calibratedAirspeed;
    }
    setIndicatedAltitude(indicatedAltitude) {
        if (this.model.isManualMode())
            this.model.manualInputData.indicatedAltitude = indicatedAltitude;
    }
    setPressure(pressure) {
        if (this.model.isManualMode())
            this.model.manualInputData.pressure = pressure;
    }
    setTotalAirTemperature(totalAirTemperature) {
        if (this.model.isManualMode())
            this.model.manualInputData.totalAirTemperature = totalAirTemperature;
    }
    setSelectedLeg(leg) {
        if (leg == "rem") {
            this.model.selectLeg(null);
        } else {
            this.model.selectLeg(parseInt(leg));
        }
    }
    /**
     * @param {Input_Stack} inputStack 
     */
    enter(inputStack) {
        this.inputHandle = inputStack.push(this.inputLayer);
    }
    exit() {
        if (this.inputHandle) {
            this.inputHandle = this.inputHandle.pop();
        }
    }
    activate() {
        this.softKeyMenuHandle = this.softKeyMenuHandler.show(this.softKeyMenu);
        this.elements.mapContainer.appendChild(this.map);
    }
    deactivate() {
        if (this.softKeyMenuHandle) {
            this.softKeyMenuHandle = this.softKeyMenuHandle.pop();
        }
    }
    showWaypointFromSelector() {
        this.showWaypointSelector.show().then(waypoint => this.model.setFromWaypoint(waypoint)).catch(e => { });
    }
    showWaypointToSelector() {
        this.showWaypointSelector.show().then(waypoint => this.model.setToWaypoint(waypoint)).catch(e => { });
    }
}
customElements.define("g1000-trip-planning", WT_Trip_Planning_View);