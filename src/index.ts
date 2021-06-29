/// <reference types="google.maps" />

import Map = google.maps.Map;
import Marker = google.maps.Marker;
import * as $ from 'jquery';

interface Coordinates {
    latitude: number;
    longitude: number;
}

interface Center {
    uuid: string;
    name: string;
    distance: number;
    address: string;
    addressNote: string;
    appointment: string;
    testKinds: string[];
    website: string;
    openingHours: string[];
    dcc: boolean;
    logo: string | null;
    marker: string | null;
    coordinates: Coordinates;
}

interface SearchResults {
    error: string;
    coordinates: Coordinates;
    centers: Center[];
}

enum AppointmentType {
    required = 'Required',
    possible = 'Possible',
    notRequired = 'NotRequired',
}

const appointmentTypeTranslations: { [id: string]: string } = {
    'Required': 'Erforderlich',
    'NotRequired': 'Nicht erforderlich',
    'Possible': 'Möglich'
}

enum TestKind {
    antigen = 'Antigen',
    pcr = 'PCR',
    vaccination = 'Vaccination'
}

const testKindTranslations: { [id: string]: string } = {
    "Antigen": "Antigentest",
    "PCR": "PCR-Test",
    "Vaccination": "Impfung"
}

const errorMessages: { [id: string]: string } = {
    'no search parameters given': 'Fehlende Suchparameter',
    'no results': 'Adresse konnte nicht gefunden werden',
    'too many results': 'Zu viele Ergebnisse, bitte Suche verfeinern'
};

const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const resultItemTemplate = document.getElementById('result-item-template') as HTMLTemplateElement;
const resultList = document.getElementById('resultList') as HTMLDivElement;
const resultsMap = document.getElementById("results-map") as HTMLDivElement;
const errorMessage = document.getElementById("error-message") as HTMLDivElement;
const usageInfo = document.getElementById("usage-info") as HTMLDivElement;

let findByLocationTimer: number;

let map: Map;
let _mapInitialized: boolean = false;
let _markers: { [id: string]: Marker } = {};
let _centers: { [id: string]: Center } = {};

let _selectedCenter: Center = null;
let _skipNextBoundsEvent = false;

const searchParams: {
    appointment?: AppointmentType,
    kind?: TestKind,
    dcc?: boolean | null,
} = {
    appointment: null,
    kind: null,
    dcc: null
};

(window as any).initMap = initMap;
(window as any).requestCurrentLocation = requestCurrentLocation;
(window as any).searchCenters = searchCenters;

export function initMap() {
    console.log('Initializing Map');
    map = new google.maps.Map(resultsMap, {
        center: {lat: 52.51632147767735, lng: 13.37770197067246},
        zoom: 15,
        disableDefaultUI: true,
        styles: [
            {
                featureType: 'poi',
                elementType: 'labels',
                stylers: [{visibility: 'off'}]
            }
        ]
    });
    map.addListener('bounds_changed', onMapBoundsChanged);
    searchInput.addEventListener('keyup', ev => {
        if (ev.key === 'Enter') {
            searchCenters();
        }
    });
}

const appointmentDropDownConfig = [
    {
        value: null,
        displayName: 'Alle'
    },
    {
        value: AppointmentType.possible,
        displayName: 'Möglich'
    },
    {
        value: AppointmentType.required,
        displayName: 'Erforderlich'
    },
    {
        value: AppointmentType.notRequired,
        displayName: 'Nicht erforderlich'
    }
]

const kindDropDownConfig = [
    {
        value: null,
        displayName: 'Alle'
    },
    {
        value: TestKind.antigen,
        displayName: 'Antigentest',
    },
    {
        value: TestKind.pcr,
        displayName: 'PCR-Test',
    },
    {
        value: TestKind.vaccination,
        displayName: 'Impfung',
    },

]

function initDropdowns() {
    appointmentDropDownConfig.forEach(elem => {
        $("<li></li>").append(
            $("<a/>", {
                "class": "dropdown-item",
                'data-value': elem.value,
                'href': '#',
                text: elem.displayName,
                click: function () {
                    searchParams.appointment = elem.value;
                    searchByMapBounds(0);
                    $("#terminButton").html(elem.displayName);
                }
            }))
            .appendTo($(".terminDropdown ul"));
    });
    $("#terminButton").html(appointmentDropDownConfig[0].displayName);

    kindDropDownConfig.forEach(elem => {
        $("<li></li>").append(
            $("<a/>", {
                "class": "dropdown-item",
                'data-value': elem.value,
                'href': '#',
                text: elem.displayName,
                click: function () {
                    searchParams.kind = elem.value;
                    searchByMapBounds(0);
                    $("#testArtButton").html(elem.displayName);
                }
            }))
            .appendTo($(".testArtDropdown ul"));
    });
    $("#testArtButton").html(kindDropDownConfig[0].displayName);

    $("#dccCheckbox").on('click', function () {
        if (searchParams.dcc !== null) {
            searchParams.dcc = !searchParams.dcc
        } else {
            searchParams.dcc = true;
        }
        searchByMapBounds(0);
    });
}

/**
 * Is called when the bounds of the map has been changed.
 * This will trigger a new search within the bounds of the map.
 */
function onMapBoundsChanged() {
    if (!_mapInitialized) {
        _mapInitialized = true;
        requestCurrentLocation();
        return;
    }
    console.log(_skipNextBoundsEvent);
    if (!_skipNextBoundsEvent) {
        searchByMapBounds(500);
    }
    _skipNextBoundsEvent = false;
}

function searchByMapBounds(delay: number) {
    const center = map.getCenter();
    findByLocation(center.lat(), center.lng(), getCurrentSearchDistance(), false, delay);
}

/**
 * Gets the current search distance to effectively use the maps bounds
 * @returns {number}
 */
function getCurrentSearchDistance(): number {
    const center = map.getCenter();
    const northEast = map.getBounds().getNorthEast();
    return haversineDistance(center.lat(), center.lng(), northEast.lat(), center.lng());
}

export function searchCenters() {
    errorMessage.innerText = '';
    if (searchInput.value.trim() == '') {
        return;
    }
    _skipNextBoundsEvent = true;
    map.setZoom(15);
    findByAddress(searchInput.value, getCurrentSearchDistance());
}

/**
 * Finds testcenters by address within the given distance.
 * @param address
 * @param distance
 */
function findByAddress(address: string, distance: number) {
    address = encodeURI(address);
    const params: { [id: string]: string | number | boolean } = {
        "address": address,
        "distance": distance,
    };

    fetch(`/api/centers?${prepareSearchParams(params)}`)
        .then(response => handleResponse(response))
        .then(data => handleResults(data, true))
        .catch(_ => {
        });
}

/**
 * Finds testcenters by location within the given distance.
 * This function will delay the request by the given amount of time
 * @param lat
 * @param lng
 * @param distance
 * @param centerMap
 * @param delay
 */
function findByLocation(lat: number, lng: number, distance: number, centerMap: boolean, delay = 0) {
    clearTimeout(findByLocationTimer);
    findByLocationTimer = setTimeout(() => {
        const params: { [id: string]: string | number | boolean } = {
            "lat": lat,
            "lng": lng,
            "distance": distance,
        };
        fetch(`/api/centers?${prepareSearchParams(params)}`)
            .then(response => handleResponse(response))
            .then(data => handleResults(data, centerMap))
            .catch(_ => {
            });
    }, delay);
}

function prepareSearchParams(params: { [id: string]: string | number | boolean }): string {
    params['dcc'] = searchParams.dcc;
    params['kind'] = searchParams.kind;
    params['appointment'] = searchParams.appointment;

    return Object.keys(params)
        .filter(k => params[k] != null)
        .map(k => k + '=' + params[k])
        .join("&");
}

/**
 * Handles the search results response.
 * @param response response returned from the api
 */
function handleResponse(response: Response): any {
    if (!response.ok) {
        response.json().then(error => handleError(error));
        throw new Error('error');
    }
    return response.json();
}

/**
 * Handles the search results.
 * @param result
 * @param centerMap
 */
function handleResults(result: SearchResults, centerMap: boolean) {
    clearResults();

    // center map to search point
    if (centerMap === true) {
        _skipNextBoundsEvent = true;
        setMapPosition(result.coordinates.latitude, result.coordinates.longitude);
    }
    recalculateDistances(result);

    for (const center of result.centers) {
        _centers[center.uuid] = center;
        const resultPanel = createCenterPanel(center);
        resultList.appendChild(resultPanel);

        if (_selectedCenter && _selectedCenter.uuid == center.uuid) {
            selectPanel(center, false);
        }

        const marker = new google.maps.Marker({
            position: {lat: center.coordinates.latitude, lng: center.coordinates.longitude},
            title: center.name,
            icon: getMarkerIcon(center),
            map: map,
        });
        marker.addListener('click', () => {
            selectCenter(center, false, true);
        });
        _markers[center.uuid] = marker;
    }
    usageInfo.setAttribute('aria-has-results', result.centers && result.centers.length ? 'true' : 'false');
}

function recalculateDistances(result: SearchResults) {
    for (const center of result.centers) {
        center.distance = haversineDistance(center.coordinates.latitude, center.coordinates.longitude,
            result.coordinates.latitude, result.coordinates.longitude);
    }
    result.centers.sort((a, b) => a.distance - b.distance);
}

/**
 * Clears the current search results
 */
function clearResults() {
    // clear result list
    while (resultList.firstChild) {
        resultList.firstChild.remove();
    }

    // remove all markers
    for (const marker in _markers) {
        if (!_markers.hasOwnProperty(marker)) {
            continue;
        }
        _markers[marker].setMap(null);
    }
    _markers = {};
    _centers = {};
}

/**
 * Creates a new panel for the given center
 * @param center the center to create the panel for
 * @returns {Node} the panel
 */
function createCenterPanel(center: Center) {
    const fragment = document.importNode(resultItemTemplate.content, true);

    const root = fragment.querySelector('#center-item');
    root.id = `center_${center.uuid}`;

    const name = fragment.querySelector('#name');
    name.id = `center_${center.uuid}_name`;
    name.textContent = center.name;

    const address = fragment.querySelector('#address');
    address.id = `center_${center.uuid}_address`;
    address.textContent = center.address;

    const appointment = fragment.querySelector('#appointment');
    appointment.id = `center_${center.uuid}_appointment`;
    appointment.textContent = `Terminbuchung: ${center.appointment ? appointmentTypeTranslations[center.appointment] : 'Unbekannt'}`;

    const kinds = fragment.querySelector('#kinds');
    kinds.id = `center_${center.uuid}_kinds`;
    kinds.textContent = `Tests: ${center.testKinds && center.testKinds.length > 0 ? center.testKinds.map(k => testKindTranslations[k]).join(', ') : 'Unbekannt'}`;

    const route = fragment.querySelector('#route') as HTMLLinkElement;
    route.id = `center_${center.uuid}_route`;
    route.href = `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${encodeURI(center.address)}`;

    const logo = fragment.querySelector('#logo') as HTMLImageElement;
    if (center.logo) {
        logo.src = center.logo;
    } else {
        logo.remove();
    }

    if (!center.dcc) {
        fragment.querySelector('#dcc').remove();
    }

    const website = fragment.querySelector('#website') as HTMLLinkElement;
    if (center.website) {
        website.href = center.website;
    } else {
        website.remove();
    }

    const openinghoursButton = fragment.querySelector('#openinghours-button') as HTMLLinkElement;
    openinghoursButton.id = `center_${center.uuid}_openinghours-button`;
    openinghoursButton.href = `#center_${center.uuid}_openinghours-panel`;

    const openinghoursPanel = fragment.querySelector('#openinghours-panel');
    openinghoursPanel.id = `center_${center.uuid}_openinghours-panel`;

    if (center.openingHours) {
        const openingHoursList = openinghoursPanel.querySelector('#openinghours-list') as HTMLUListElement;
        center.openingHours.forEach(value => {
            const entry = document.createElement('li') as HTMLLIElement;
            entry.innerText = value;
            openingHoursList.append(entry);
        });
        fragment.querySelector('#no-openinghours').remove();
    } else {
        openinghoursButton.remove();
    }

    const selectButton = fragment.querySelector('#select');
    selectButton.id = `center_${center.uuid}_select`;
    selectButton.addEventListener('click', () => {
        selectCenter(center, true, false)
    });

    const note = fragment.querySelector('#note');
    note.id = `center_${center.uuid}_note`;
    if (!center.addressNote) {
        note.remove();
    } else {
        const noteText = fragment.querySelector('#note-text') as HTMLParagraphElement;
        noteText.id = `center_${center.uuid}_note-text`;
        noteText.innerText = center.addressNote;
    }
    return fragment;
}

/**
 * Selects the given center
 * @param center the center to be selected
 * @param centerMap should the center be centered in the map
 * @param scrollIntoView should the center panel be scrolled into view
 */
function selectCenter(center: Center, centerMap: boolean, scrollIntoView: boolean) {
    _selectedCenter = center;
    selectMarker(center, centerMap);
    selectPanel(center, scrollIntoView);
}

/**
 * Selects the panel for the given center
 * @param center the center to be selected
 * @param scrollIntoView should the panel scrolled be into view
 */
function selectPanel(center: Center, scrollIntoView: boolean) {
    const activeList = resultList.querySelector('.border-info');
    if (activeList) {
        activeList.classList.remove('border-info');
    }


    const selectedPanel = document.getElementById(`center_${center.uuid}`);
    if (!selectedPanel) {
        return;
    }

    selectedPanel.classList.add('border-info');
    resultList.prepend(selectedPanel);

    if (scrollIntoView) {
        selectedPanel.scrollIntoView();
    }
}

function selectMarker(center: Center, centerMap: boolean) {
    for (const marker in _markers) {
        if (!_markers.hasOwnProperty(marker)) {
            continue;
        }
        _markers[marker].setIcon(getMarkerIcon(_centers[marker]));
    }

    if (centerMap) {
        resultsMap.scrollIntoView();
        map.setCenter({lat: center.coordinates.latitude, lng: center.coordinates.longitude});
        map.setZoom(15);
    }
}

function getMarkerIcon(center: Center) {
    if (_selectedCenter && _selectedCenter.uuid === center.uuid) {
        return 'https://maps.google.com/mapfiles/ms/icons/green-dot.png';
    }

    // if (center.operator.icon) {
    //     return center.operator.icon;
    // }
    if (center.marker) {
        return center.marker;
    }
    if (center.dcc) {
        return '/img/eu_marker.png';
    }
    return 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png';
}

function setMapPosition(lat: number, lng: number) {
    map.setCenter({lat, lng});
}

/**
 * Handles API errors
 * @param error the error
 */
function handleError(error: any) {
    errorMessage.innerText = errorMessages[error.message] || error.message;
}

/**
 * Tries to detect the current users position
 */
export function requestCurrentLocation() {
    if (!navigator.geolocation) {
        console.log('Geolocation is not supported');
    } else {
        searchInput.value = '';
        navigator.geolocation.getCurrentPosition(onGeolocationSuccess, onGeolocationError);
    }
}

/**
 * Called after successfully detecting the users location.
 * @param position the users location
 */
function onGeolocationSuccess(position: GeolocationPosition) {
    setMapPosition(position.coords.latitude, position.coords.longitude);
    //findByLocation(position.coords.latitude, position.coords.longitude, 1.0, false, 0);
}

/**
 * Called when there is an error in detecting the users location.
 */
function onGeolocationError() {
    console.log('onGeolocationError');
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRadian = (angle: number) => (Math.PI / 180) * angle;
    const distance = (a: number, b: number) => (Math.PI / 180) * (a - b);
    const RADIUS_OF_EARTH_IN_KM = 6371;

    const dLat = distance(lat2, lat1);
    const dLon = distance(lon2, lon1);

    lat1 = toRadian(lat1);
    lat2 = toRadian(lat2);

    // Haversine Formula
    const a =
        Math.pow(Math.sin(dLat / 2), 2) +
        Math.pow(Math.sin(dLon / 2), 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.asin(Math.sqrt(a));

    return RADIUS_OF_EARTH_IN_KM * c;
}

$(function () {
    initDropdowns();
})