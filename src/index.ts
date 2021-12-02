/*
 * Corona-Warn-App / cwa-verification
 *
 * (C) 2020, T-Systems International GmbH
 *
 * Deutsche Telekom AG and all other contributors /
 * copyright owners license this file to you under the Apache
 * License, Version 2.0 (the "License"); you may not use this
 * file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import Map = google.maps.Map;
import Marker = google.maps.Marker;
import LatLngLiteral = google.maps.LatLngLiteral;
import * as $ from 'jquery';

interface GeocodeResults {
    address: string;
    bounds: Bounds;
}

interface Bounds {
    northEast: Coordinates;
    southWest: Coordinates;
}

interface Coordinates {
    latitude: number;
    longitude: number;
}

enum TestKind {
    antigen = 'Antigen',
    pcr = 'PCR',
    vaccination = 'Vaccination'
}

enum AppointmentType {
    required = 'Required',
    possible = 'Possible',
    notRequired = 'NotRequired',
}

interface Center {
    uuid: string;
    name: string;
    distance: number;
    address: string;
    addressNote: string;
    appointment: AppointmentType;
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
    centers: Center[];
}

interface DrowdownItem<T extends string> {
    value: T | null;
    display: string;
}

const appointmentTypes: { [id: string]: DrowdownItem<AppointmentType> } = {
    'All': {value: null, display: 'Alle'},
    'Required': {value: AppointmentType.required, display: 'Erforderlich'},
    'Possible': {value: AppointmentType.possible, display: 'Möglich'},
    'NotRequired': {value: AppointmentType.notRequired, display: 'Nicht notwendig'},
}

const testKinds: { [id: string]: DrowdownItem<TestKind> } = {
    'All': {value: null, display: 'Alle'},
    'Antigen': {value: TestKind.antigen, display: 'Antigentest'},
    'PCR': {value: TestKind.pcr, display: 'PCR-Test'},
    'Vaccination': {value: TestKind.vaccination, display: 'Impfung'},
}

const errorMessages: { [id: string]: string } = {
    'no search parameters given': 'Fehlende Suchparameter',
    'no results': 'Adresse konnte nicht gefunden werden',
    'too many results': 'Zu viele Ergebnisse, bitte Suche verfeinern'
};

const _searchInput = document.getElementById('searchInput') as HTMLInputElement;
const _resultItemTemplate = document.getElementById('result-item-template') as HTMLTemplateElement;
const _resultList = document.getElementById('resultList') as HTMLDivElement;
const _resultsMap = document.getElementById("results-map") as HTMLDivElement;
const _errorMessage = document.getElementById("error-message") as HTMLDivElement;

let _findByBoundsTimer: number;

let _map: Map;
let _mapInitialized: boolean = false;
let _markers: { [id: string]: Marker } = {};
let _centers: { [id: string]: Center } = {};

let _selectedCenter: Center | null = null;
let _closeReportPanelTimer: number | null = null;

const searchParams: {
    appointment: AppointmentType | null,
    kind: TestKind | null,
    dcc: boolean | null,
} = {
    appointment: null,
    kind: null,
    dcc: null
};

(window as any).initMap = initMap;
(window as any).requestCurrentLocation = requestCurrentLocation;
(window as any).searchCenters = searchCenters;
(window as any).clearSelection = clearSelection;
(window as any).toggleReportPanel = toggleReportPanel;
(window as any).submitReport = submitReport;

export function initMap() {
    _map = new google.maps.Map(_resultsMap, {
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
    _map.addListener('bounds_changed', onMapBoundsChanged);
    _searchInput.addEventListener('keyup', ev => {
        if (ev.key === 'Enter') {
            searchCenters();
        }
    });
}

function populateDropdown<T extends string>(prefix: string, defaultItem: string, items: { [id: string]: DrowdownItem<T> }, handler: (item: T | null) => void) {
    const dropdownItems = document.getElementById(`${prefix}-dropdown`);
    const dropdownButton = document.getElementById(`${prefix}-dropdown-button`);
    if (dropdownButton == null || dropdownItems == null) {
        return;
    }

    dropdownButton.innerText = items[defaultItem].display;
    for (const itemKey in items) {
        const item = items[itemKey]
        const linkItem = document.createElement('a');
        linkItem.classList.add('dropdown-item');
        linkItem.href = '#';
        if (item.value != null) {
            linkItem.setAttribute('data-value', item.value);
        }
        linkItem.innerText = item.display;
        linkItem.onclick = () => {
            dropdownButton.innerText = item.display;
            handler(item.value);
        };

        const listItem = document.createElement('li');
        listItem.append(linkItem);
        dropdownItems.append(listItem);
    }
}

function initializeFilterOptions() {
    populateDropdown('appointment', 'All', appointmentTypes, item => {
        searchParams.appointment = item;
        searchByMapBounds(0);
    });

    populateDropdown('testKind', 'All', testKinds, item => {
        searchParams.kind = item;
        searchByMapBounds(0);
    });

    const dccCheckbox = document.getElementById('dcc-checkbox') as HTMLInputElement;
    if (dccCheckbox != null) {
        dccCheckbox.onclick = () => {
            searchParams.dcc = dccCheckbox.checked;
            searchByMapBounds(0);
        };
    }
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
    searchByMapBounds(500);
}

/**
 * Searches centers within the current map bounds.
 * @param delay a delay before search should be performed
 */
function searchByMapBounds(delay: number) {
    const bounds = _map.getBounds();
    if (!bounds) {
        return;
    }

    const northeast = bounds.getNorthEast();
    const southwest = bounds.getSouthWest();
    findByBounds({latitude: northeast.lat(), longitude: northeast.lng()},
        {latitude: southwest.lat(), longitude: southwest.lng()}, delay);
}

export function searchCenters() {
    _errorMessage.innerText = '';
    if (_searchInput.value.trim() == '') {
        return;
    }
    findByAddress(_searchInput.value);
}

/**
 * Finds testcenters by address within the given distance.
 * @param address
 */
function findByAddress(address: string) {
    fetch(`/api/centers/bounds?address=${encodeURI(address)}`)
        .then(response => handleResponse<GeocodeResults>(response))
        .then(data => handleGetBoundsResult(data))
        .catch(_ => {
        });
}

/**
 * Finds testcenters by location within the given distance.
 * This function will delay the request by the given amount of time
 * @param northeast
 * @param southwest
 * @param delay
 */
function findByBounds(northeast: Coordinates, southwest: Coordinates, delay = 0) {
    clearTimeout(_findByBoundsTimer);
    _findByBoundsTimer = setTimeout(() => {
        const params: { [id: string]: string | number | boolean } = {
            "latne": northeast.latitude,
            "lngne": northeast.longitude,
            "latsw": southwest.latitude,
            "lngsw": southwest.longitude,
        };
        fetch(`/api/centers?${prepareSearchParams(params)}`)
            .then(response => handleResponse<SearchResults>(response))
            .then(data => handleFindByBoundsResults(data, false))
            .catch(_ => {
            });
    }, delay);
}

function prepareSearchParams(params: { [id: string]: string | number | boolean | null }): string {
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
function handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        response.json().then(error => handleError(error));
        throw new Error('error');
    }
    return response.json() as Promise<T>;
}

/**
 * Handles the /centers/bounds result.
 * This will set will set the maps zoom level, that the returned bounds will fit into the map.
 *
 * Setting the maps bounds will trigger a search by bounds.
 * @param result
 */
function handleGetBoundsResult(result: GeocodeResults) {
    _searchInput.value = result.address;
    _map.fitBounds(new google.maps.LatLngBounds(
        {lat: result.bounds.southWest.latitude, lng: result.bounds.southWest.longitude} as LatLngLiteral,
        {lat: result.bounds.northEast.latitude, lng: result.bounds.northEast.longitude} as LatLngLiteral
    ), 0);
}

/**
 * Handles the search results.
 * @param result
 * @param centerMap
 */
function handleFindByBoundsResults(result: SearchResults, centerMap: boolean) {
    let resultCenterMap: { [id: string]: boolean } = {};
    for (const center of result.centers) {
        resultCenterMap[center.uuid] = true;

        if (_centers[center.uuid]) {
            // if center is already in the list, skip processing
            continue;
        }

        if (_centers[center.uuid]) {
            // if center is already in the list, skip processing
            continue;
        }

        const marker = new google.maps.Marker({
            position: {lat: center.coordinates.latitude, lng: center.coordinates.longitude},
            title: center.name,
            icon: getMarkerIcon(center),
            map: _map,
        });

        marker.addListener('click', () => {
            setSelectedCenter(center, false);
        });

        _centers[center.uuid] = center;
        _markers[center.uuid] = marker;
    }

    if (_selectedCenter != null && !resultCenterMap[_selectedCenter.uuid]) {
        showCenterDetails(null);
    }

    for (const center in _centers) {
        if (!resultCenterMap[center]) {
            google.maps.event.clearInstanceListeners(_markers[center]);
            _markers[center].setMap(null);
            delete _markers[center];
            delete _centers[center];
        }
    }
}

/**
 * Creates a new panel for the given center
 * @param center the center to create the panel for
 * @returns {Node} the panel
 */
function createCenterPanel(center: Center): Element | null {
    const fragment = document.importNode(_resultItemTemplate.content, true);

    const root = fragment.querySelector('#center-item');
    if (root == null) {
        return null;
    }

    root.id = `center_${center.uuid}`;

    const name = fragment.querySelector('#name');
    if (name == null) {
        return null;
    }
    name.id = `center_${center.uuid}_name`;
    name.textContent = center.name;

    const address = fragment.querySelector('#address');
    if (address == null) {
        return null;
    }
    address.id = `center_${center.uuid}_address`;
    address.textContent = center.address;

    const appointment = fragment.querySelector('#appointment');
    if (appointment == null) {
        return null;
    }
    appointment.id = `center_${center.uuid}_appointment`;
    appointment.textContent = `Terminbuchung: ${center.appointment ? appointmentTypes[center.appointment].display : 'Unbekannt'}`;

    const kinds = fragment.querySelector('#kinds');
    if (kinds == null) {
        return null;
    }
    kinds.id = `center_${center.uuid}_kinds`;
    kinds.textContent = `Tests: ${center.testKinds && center.testKinds.length > 0 ? center.testKinds.map(k => testKinds[k].display).join(', ') : 'Unbekannt'}`;

    const route = fragment.querySelector('#route') as HTMLLinkElement;
    route.id = `center_${center.uuid}_route`;
    route.href = `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${encodeURI(center.address)}`;

    const logo = fragment.querySelector('#operatorLogo') as HTMLImageElement;
    if (center.logo) {
        logo.src = center.logo;
    } else {
        logo.remove();
    }

    if (!center.dcc) {
        const dcc = fragment.querySelector('#dccLogo');
        if (dcc != null) {
            dcc.remove()
        }
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
    if (openinghoursPanel == null) {
        return null;
    }
    openinghoursPanel.id = `center_${center.uuid}_openinghours-panel`;

    if (center.openingHours) {
        const openingHoursList = openinghoursPanel.querySelector('#openinghours-list') as HTMLUListElement;
        center.openingHours.forEach(value => {
            const entry = document.createElement('li') as HTMLLIElement;
            entry.innerText = value;
            openingHoursList.append(entry);
        });
        const noOpeningHours = fragment.querySelector('#no-openinghours');
        if (noOpeningHours != null) {
            noOpeningHours.remove();
        }
    } else {
        openinghoursButton.remove();
    }

    const selectButton = fragment.querySelector('#select');
    if (selectButton == null) {
        return null;
    }
    selectButton.id = `center_${center.uuid}_select`;
    selectButton.addEventListener('click', () => {
        selectCenterMarker(center, true)
    });

    const note = fragment.querySelector('#note');
    if (note == null) {
        return null;
    }
    note.id = `center_${center.uuid}_note`;
    if (!center.addressNote) {
        note.remove();
    } else {
        const noteText = fragment.querySelector('#note-text') as HTMLParagraphElement;
        noteText.id = `center_${center.uuid}_note-text`;
        noteText.innerText = center.addressNote;
    }
    return root;
}

function clearSelection() {
    setSelectedCenter(null, false);
}

/**
 * Selects the given center
 * @param center the center to be selected
 * @param centerMap should the center be centered in the map
 */
function setSelectedCenter(center: Center | null, centerMap: boolean) {
    _selectedCenter = _selectedCenter == center ? null : center;
    selectCenterMarker(_selectedCenter, centerMap);
    showCenterDetails(_selectedCenter);
}

/**
 * Shows the details panel for the given center.
 * @param center the center, for which the details panel should be shown
 */
function showCenterDetails(center: Center | null) {
    while (_resultList.firstChild) {
        _resultList.firstChild.remove();
    }

    if (center != null) {
        const selectedPanel = createCenterPanel(center);
        if (selectedPanel == null) {
            return;
        }
        _resultList.prepend(selectedPanel);
    }
}

function selectCenterMarker(center: Center | null, centerMap: boolean) {
    for (const marker in _markers) {
        if (!_markers.hasOwnProperty(marker)) {
            continue;
        }
        _markers[marker].setIcon(getMarkerIcon(_centers[marker]));
    }

    if (centerMap && center != null) {
        _resultsMap.scrollIntoView();
        _map.setCenter({lat: center.coordinates.latitude, lng: center.coordinates.longitude});
        _map.setZoom(15);
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

/**
 * Handles API errors
 * @param error the error
 */
function handleError(error: any) {
    _errorMessage.innerText = errorMessages[error.message] || error.message;
}

/**
 * Tries to detect the current users position
 */
export function requestCurrentLocation() {
    if (!navigator.geolocation) {
        console.log('Geolocation is not supported');
    } else {
        _searchInput.value = '';
        navigator.geolocation.getCurrentPosition(onGeolocationSuccess, onGeolocationError);
    }
}

/**
 * Called after successfully detecting the users location.
 * @param position the users location
 */
function onGeolocationSuccess(position: GeolocationPosition) {
    _map.setCenter({lat: position.coords.latitude, lng: position.coords.longitude});
}

/**
 * Called when there is an error in detecting the users location.
 */
function onGeolocationError() {
    console.log('onGeolocationError');
}

function toggleReportPanel(close: boolean = false) {
    const detailsPanel = document.getElementById('detailsPanel');
    const reportPanel = document.getElementById('reportPanel');

    if (detailsPanel == null || reportPanel == null) {
        return;
    }

    if (_closeReportPanelTimer != null) {
        clearTimeout(_closeReportPanelTimer);
    }

    if (close) {
        reportPanel.style.display = 'none';
        detailsPanel.style.display = '';
    } else {
        reportPanel.style.display = '';
        detailsPanel.style.display = 'none';
    }

    const submitReportPanel = document.getElementById("submitReportPanel");
    if (submitReportPanel != null) {
        submitReportPanel.style.display = '';
    }

    const reportSubmittedPanel = document.getElementById("reportSubmittedPanel");
    if (reportSubmittedPanel != null) {
        reportSubmittedPanel.style.display = 'none';
    }
}

function submitReport() {
    if (!_selectedCenter) {
        return;
    }

    const subject = document.getElementById("subject") as HTMLSelectElement;
    const message = document.getElementById("message") as HTMLTextAreaElement;
    fetch(`/api/centers/${_selectedCenter.uuid}/report`, {
        method: 'POST',
        body: JSON.stringify({
            subject: subject.value,
            message: message.value
        })
    }).then(response => {
        if (response.ok) {
            const submitReportPanel = document.getElementById("submitReportPanel");
            if (submitReportPanel != null) {
                submitReportPanel.style.display = 'none';
            }

            const reportSubmittedPanel = document.getElementById("reportSubmittedPanel");
            if (reportSubmittedPanel != null) {
                reportSubmittedPanel.style.display = '';
            }

            if (_closeReportPanelTimer != null) {
                clearTimeout(_closeReportPanelTimer);
            }
            _closeReportPanelTimer = setTimeout(() => {
                _closeReportPanelTimer = null;
                toggleReportPanel(true);
            }, 3000);
            return;
        }
    }).catch(reason => console.log(reason));
}

$(function () {
    initializeFilterOptions();
})
