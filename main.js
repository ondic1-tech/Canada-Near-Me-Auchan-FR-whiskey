import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const PRODUCT_URL = 'https://www.coursesu.com/p/whisky-canadien-5-ans-dage-sam-barton-40-70cl/480185.html';
const DRIVE_URL = 'https://www.coursesu.com/drive/home';
const PRODUCT_ID = '480185';
const EAN = '3147690052906';
const minPopulation = Math.max(1000, Number(input.minPopulation ?? 20000));
const maxCities = Math.max(1, Number(input.maxCities ?? 150));
const maxStoresPerCityToCheck = Math.max(1, Number(input.maxStoresPerCityToCheck ?? 4));
const maxOutputRows = Math.max(1, Number(input.maxOutputRows ?? 200));
const useApifyProxy = input.useApifyProxy !== false;
const proxyGroups = String(input.proxyGroups ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function normalized(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isParis(value) {
    return normalized(value) === 'paris';
}

function isCentralParis(postalCode) {
    return /^(7500[1-8])$/.test(String(postalCode ?? ''));
}

function parseCustomCities(value) {
    return String(value ?? '')
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

async function loadCities() {
    const custom = parseCustomCities(input.cities);
    if (custom.length) return [...new Set(['Paris', ...custom])].slice(0, maxCities);

    try {
        const response = await fetch('https://geo.api.gouv.fr/communes?fields=nom,population&format=json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rows = await response.json();
        const cities = rows
            .filter((row) => Number(row.population ?? 0) >= minPopulation)
            .sort((a, b) => Number(b.population ?? 0) - Number(a.population ?? 0))
            .map((row) => row.nom)
            .filter(Boolean);
        return [...new Set(['Paris', ...cities.filter((city) => !isParis(city))])].slice(0, maxCities);
    } catch (error) {
        log.warning(`Automatic city list unavailable: ${error.message}`);
        return [
            'Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice', 'Nantes', 'Montpellier',
            'Strasbourg', 'Bordeaux', 'Lille', 'Rennes', 'Reims', 'Toulon', 'Saint-Étienne',
            'Le Havre', 'Grenoble', 'Dijon', 'Angers', 'Nîmes', 'Villeurbanne', 'Clermont-Ferrand',
            'Le Mans', 'Aix-en-Provence', 'Brest', 'Tours', 'Amiens', 'Limoges', 'Annecy',
            'Perpignan', 'Metz', 'Besançon', 'Orléans', 'Rouen', 'Caen', 'Mulhouse',
            'Nancy', 'Argenteuil', 'Montreuil', 'Roubaix', 'Tourcoing', 'Avignon', 'Poitiers',
            'Dunkerque', 'La Rochelle', 'Pau', 'Calais', 'Ajaccio', 'Bastia', 'Colmar', 'Valence',
        ].slice(0, maxCities);
    }
}

async function dismissCookies(page) {
    for (const selector of ['#footer_tc_privacy_button', 'button:has-text("Accepter tout")']) {
        try {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1200 })) await button.click({ timeout: 3000 });
        } catch {
            // No cookie dialog.
        }
    }
}

async function openStoreSearch(page, city) {
    await page.goto(DRIVE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookies(page);

    const search = page.locator('#store-search');
    await search.waitFor({ state: 'visible', timeout: 30000 });
    await search.fill('');
    await search.type(city, { delay: 35 });
    await page.locator('[data-prehome-city-suggestion]').first().waitFor({ state: 'visible', timeout: 20000 });

    const suggestions = page.locator('[data-prehome-city-suggestion]');
    const count = await suggestions.count();
    let chosen = null;
    for (let index = 0; index < count; index += 1) {
        const suggestion = suggestions.nth(index);
        const name = await suggestion.getAttribute('data-city-name');
        const trusted = await suggestion.getAttribute('data-autocomplete-trust');
        if (normalized(name) === normalized(city) && trusted === 'true') {
            chosen = suggestion;
            break;
        }
        if (!chosen && normalized(name) === normalized(city)) chosen = suggestion;
    }
    if (!chosen) return [];

    await chosen.click({ timeout: 10000 });
    await page.locator('.store-container').first().waitFor({ state: 'visible', timeout: 30000 });

    const stores = await page.locator('.store-container').evaluateAll((elements) => elements.map((element) => {
        const postalCode = element.getAttribute('data-city-zipcode') ?? '';
        const cityName = element.getAttribute('data-city-name') ?? '';
        const storeId = element.getAttribute('data-store-id') ?? element.id ?? '';
        const name = element.querySelector('[data-store-name]')?.textContent?.trim() ?? '';
        const address = element.querySelector('.store-address')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const hasDrive = Boolean(element.querySelector('.mode-RETRAIT [data-delivery-mode-arrow]'));
        return { storeId, name, address, postalCode, city: cityName, hasDrive };
    }));

    return stores.filter((store) => store.storeId && store.hasDrive && normalized(store.city) === normalized(city));
}

async function selectStore(page, storeId) {
    const selector = `.store-container[data-store-id="${storeId}"] .mode-RETRAIT [data-delivery-mode-arrow]`;
    const link = page.locator(selector).first();
    await link.waitFor({ state: 'attached', timeout: 15000 });

    await Promise.allSettled([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
        link.click({ force: true, timeout: 10000 }),
    ]);
    await page.waitForTimeout(1200);
}

async function productIsAvailable(page) {
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCookies(page);
    await page.locator('body').waitFor({ state: 'visible', timeout: 20000 });

    const body = (await page.locator('body').innerText({ timeout: 20000 })).replace(/\s+/g, ' ');
    const correctProduct = /Whisky Canadien 5 ans d['’]âge SAM BARTON/i.test(body);
    const asksForStore = /Afficher le prix|sélectionner votre magasin|Choisir un magasin/i.test(body);
    const unavailable = /indisponible|épuisé|plus disponible|non disponible/i.test(body);
    const hasPrice = /\b\d{1,3}[,.]\d{2}\s*€/.test(body);
    const addButton = await page.locator('button').filter({ hasText: /ajouter|mettre au panier/i }).count();

    return correctProduct && !asksForStore && !unavailable && (hasPrice || addButton > 0);
}

async function geocode(address) {
    try {
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('countrycodes', 'fr');
        url.searchParams.set('q', `${address}, France`);
        const response = await fetch(url, {
            headers: {
                accept: 'application/json',
                'user-agent': 'CanadaNearMe/1.0 (public product availability research)',
            },
        });
        if (!response.ok) return { latitude: null, longitude: null };
        const row = (await response.json())[0];
        return row ? { latitude: Number(row.lat), longitude: Number(row.lon) } : { latitude: null, longitude: null };
    } catch {
        return { latitude: null, longitude: null };
    }
}

function makeRow(store, coordinates) {
    const checkedAt = new Date();
    const expiresAt = new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
        candidate_id: `coursesu-fr-${PRODUCT_ID}-${store.storeId}`,
        product_id: PRODUCT_ID,
        ean: EAN,
        product_name: "Whisky Canadien 5 ans d'âge SAM BARTON, 40°, 70cl",
        brand: 'Sam Barton',
        brand_owner_name: 'La Martiniquaise-Bardinet',
        brand_owner_country: 'FR',
        category: 'Food & Grocery',
        made_in_country: 'CA',
        origin_evidence_text: 'SAM BARTON est élaboré au Canada et vieilli 5 ans en fût de chêne canadien.',
        origin_evidence_url: PRODUCT_URL,
        retailer: 'Coopérative U',
        store_id: store.storeId,
        store_name: store.name,
        address: store.address,
        postal_code: store.postalCode,
        city: store.city,
        country_code: 'FR',
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        availability_status: 'in_stock',
        availability_quantity: null,
        availability_evidence_text: 'Price or add-to-cart control displayed after selecting this physical U store.',
        availability_evidence_url: PRODUCT_URL,
        product_url: PRODUCT_URL,
        physical_store_only: true,
        map_ready: coordinates.latitude !== null && coordinates.longitude !== null,
        checked_at: checkedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        scraper_version: 'coursesu-sam-barton-fr-1.0.0',
    };
}

const cities = await loadCities();
const proxyConfiguration = useApifyProxy
    ? await Actor.createProxyConfiguration({
        useApifyProxy: true,
        ...(proxyGroups.length ? { groups: proxyGroups } : {}),
        countryCode: 'FR',
    })
    : undefined;
let outputCount = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestRetries: 8,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 20,
        sessionOptions: {
            maxUsageCount: 4,
            maxErrorScore: 1,
        },
    },
    requestHandlerTimeoutSecs: 2400,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--disable-dev-shm-usage'],
        },
    },
    preNavigationHooks: [async ({ page }) => {
        await page.setExtraHTTPHeaders({
            'accept-language': 'fr-FR,fr;q=0.9,en;q=0.7',
            'upgrade-insecure-requests': '1',
        });
    }],
    async requestHandler({ page }) {
        for (const city of cities) {
            if (outputCount >= maxOutputRows) break;
            const targetCount = isParis(city) ? 3 : 1;
            const checkLimit = isParis(city) ? Math.max(15, maxStoresPerCityToCheck) : maxStoresPerCityToCheck;
            const selected = [];

            try {
                let stores = await openStoreSearch(page, city);
                stores = stores.sort((a, b) => {
                    if (!isParis(city)) return 0;
                    return Number(isCentralParis(b.postalCode)) - Number(isCentralParis(a.postalCode));
                });

                for (const store of stores.slice(0, checkLimit)) {
                    if (selected.length >= targetCount) break;
                    try {
                        if (!page.url().startsWith(DRIVE_URL)) await openStoreSearch(page, city);
                        await selectStore(page, store.storeId);
                        if (!(await productIsAvailable(page))) continue;

                        const coordinates = await geocode(store.address);
                        selected.push({ store, coordinates });
                        await page.waitForTimeout(1100);
                    } catch (error) {
                        log.warning(`Skipped ${city}/${store.storeId}: ${error.message}`);
                    }
                }

                if (isParis(city) && selected.length > 0) {
                    const centralIndex = selected.findIndex(({ store }) => isCentralParis(store.postalCode));
                    if (centralIndex > 0) selected.unshift(selected.splice(centralIndex, 1)[0]);
                }

                for (const item of selected.slice(0, targetCount)) {
                    await Actor.pushData(makeRow(item.store, item.coordinates));
                    outputCount += 1;
                }
                log.info(`${city}: ${selected.length} verified store(s).`);
            } catch (error) {
                log.warning(`Skipped city ${city}: ${error.message}`);
            }
        }
    },
});

await crawler.run([{ url: DRIVE_URL, uniqueKey: 'FR-SAM-BARTON' }]);
log.info(`Finished with ${outputCount} verified physical stores.`);
await Actor.exit();
