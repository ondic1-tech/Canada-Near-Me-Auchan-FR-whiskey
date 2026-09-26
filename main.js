import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();
const input = (await Actor.getInput()) ?? {};

const DIRECTORY_URL = 'https://www.intermarche.com/enseigne/magazine/tous-les-magasins';
const PRODUCT_URL = "https://www.intermarche.com/produit/whisky-canadien-5-ans-d'age-40%C2%B0/3147690052906";
const EAN = '3147690052906';
const minPopulation = Math.max(1000, Number(input.minPopulation ?? 20000));
const maxCities = Math.max(1, Number(input.maxCities ?? 150));
const maxStoresPerCityToCheck = Math.max(1, Number(input.maxStoresPerCityToCheck ?? 5));
const maxOutputRows = Math.max(1, Number(input.maxOutputRows ?? 200));

function normalized(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();
}
const isParis = (value) => normalized(value) === 'paris';
const isCentralParis = (postal) => /^(7500[1-8])$/.test(String(postal ?? ''));

async function loadCities() {
    const custom = String(input.cities ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
    if (custom.length) return [...new Set(['Paris', ...custom])].slice(0, maxCities);
    const response = await fetch('https://geo.api.gouv.fr/communes?fields=nom,population&format=json');
    if (!response.ok) throw new Error(`City list HTTP ${response.status}`);
    const cities = (await response.json())
        .filter((row) => Number(row.population ?? 0) >= minPopulation)
        .sort((a, b) => Number(b.population ?? 0) - Number(a.population ?? 0))
        .map((row) => row.nom).filter(Boolean);
    return [...new Set(['Paris', ...cities.filter((city) => !isParis(city))])].slice(0, maxCities);
}

async function dismissDialogs(page) {
    for (const pattern of [/Tout accepter/i, /Accepter tout/i, /Continuer sans accepter/i, /J'ai compris/i]) {
        try {
            const button = page.getByRole('button', { name: pattern }).first();
            if (await button.isVisible({ timeout: 800 })) await button.click({ timeout: 3000 });
        } catch {}
    }
}

async function goto(page, url) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (response && [403, 429].includes(response.status())) throw new Error(`HTTP ${response.status()}`);
    await dismissDialogs(page);
    await page.locator('body').waitFor({ state: 'visible', timeout: 20000 });
}

async function openCity(page, city) {
    await goto(page, DIRECTORY_URL);
    const links = page.locator('a');
    let href = null;
    for (let i = 0; i < await links.count(); i += 1) {
        const link = links.nth(i);
        const text = normalized(await link.innerText().catch(() => ''));
        if (text === normalized(city) || text.startsWith(`${normalized(city)} `)) {
            const candidate = await link.getAttribute('href');
            if (candidate?.includes('/tous-les-magasins/')) { href = candidate; break; }
        }
    }
    if (!href) return [];
    await goto(page, new URL(href, DIRECTORY_URL).href);

    const buttons = page.getByRole('button', { name: /^Choisir$/i });
    const candidates = [];
    for (let i = 0; i < await buttons.count(); i += 1) {
        const button = buttons.nth(i);
        const data = await button.evaluate((node, index) => {
            let parent = node.parentElement;
            while (parent && parent !== document.body) {
                const text = (parent.innerText || '').replace(/\s+/g, ' ').trim();
                if (/\b\d{5}\b/.test(text) && text.length >= 20 && text.length <= 900) {
                    const postal = text.match(/\b\d{5}\b/)?.[0] || '';
                    const address = text.match(/(?:\d{1,4}\s+[^,]+?)\s*[-–]?\s*\d{5}\s+[^\n]+/i)?.[0] || text;
                    const link = parent.querySelector('a[href*="/magasins/"]');
                    return { index, text, postal, address, infoUrl: link?.href || '' };
                }
                parent = parent.parentElement;
            }
            return null;
        }, i);
        if (data && normalized(data.text).includes(normalized(city))) candidates.push(data);
    }
    return candidates;
}

async function selectStore(page, city, candidate) {
    const stores = await openCity(page, city);
    const current = stores.find((x) => x.address === candidate.address) ?? stores[candidate.index];
    if (!current) return false;
    const buttons = page.getByRole('button', { name: /^Choisir$/i });
    const button = buttons.nth(current.index);
    await button.click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    for (const pattern of [/Confirmer/i, /^Choisir$/i, /Continuer/i]) {
        try {
            const confirm = page.getByRole('button', { name: pattern }).last();
            if (await confirm.isVisible({ timeout: 800 })) await confirm.click({ timeout: 5000 });
        } catch {}
    }
    await page.waitForTimeout(1500);
    return true;
}

async function productAvailable(page) {
    await goto(page, PRODUCT_URL);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const correct = /Sam Barton/i.test(text) && /Whisky canadien 5 ans/i.test(text);
    const unavailable = /Indisponible|non disponible|épuisé|rupture/i.test(text);
    const asksStore = /Choisir un magasin|Sélectionner un magasin/i.test(text);
    const hasPrice = /\b\d{1,3}[,.]\d{2}\s*€/.test(text);
    const addButton = await page.getByRole('button', { name: /Ajouter|panier/i }).count();
    return correct && !unavailable && !asksStore && (hasPrice || addButton > 0);
}

async function geocode(address) {
    try {
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('countrycodes', 'fr');
        url.searchParams.set('q', `${address}, France`);
        const response = await fetch(url, { headers: { 'user-agent': 'CanadaNearMe/1.0' } });
        const row = response.ok ? (await response.json())[0] : null;
        return row ? { latitude: Number(row.lat), longitude: Number(row.lon) } : { latitude: null, longitude: null };
    } catch { return { latitude: null, longitude: null }; }
}

function row(city, store, coordinates) {
    const now = new Date();
    const storeId = store.infoUrl.match(/\/magasins\/([^/]+)/)?.[1] ?? normalized(store.address).replace(/ /g, '-');
    return {
        candidate_id: `intermarche-fr-${EAN}-${storeId}`,
        product_id: EAN,
        ean: EAN,
        product_name: "Whisky canadien Sam Barton 5 ans d'âge, 40°, 70 cl",
        brand: 'Sam Barton',
        brand_owner_name: 'La Martiniquaise-Bardinet',
        brand_owner_country: 'FR',
        category: 'Food & Grocery',
        made_in_country: 'CA',
        origin_evidence_text: 'Whisky canadien, élaboré au Canada et vieilli cinq ans.',
        origin_evidence_url: PRODUCT_URL,
        retailer: 'Intermarché',
        store_id: storeId,
        store_name: `Intermarché ${city}`,
        address: store.address,
        postal_code: store.postal,
        city,
        country_code: 'FR',
        ...coordinates,
        availability_status: 'in_stock',
        availability_evidence_text: 'Price or add-to-cart control displayed after selecting this physical Intermarché store.',
        availability_evidence_url: PRODUCT_URL,
        product_url: PRODUCT_URL,
        physical_store_only: true,
        map_ready: coordinates.latitude !== null && coordinates.longitude !== null,
        checked_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 86400000).toISOString(),
        scraper_version: 'intermarche-sam-barton-fr-1.0.0'
    };
}

const groups = String(input.proxyGroups ?? 'RESIDENTIAL').split(',').map((x) => x.trim()).filter(Boolean);
const proxyConfiguration = input.useApifyProxy === false ? undefined : await Actor.createProxyConfiguration({
    useApifyProxy: true,
    groups,
    countryCode: 'FR'
});
const cities = await loadCities();
let total = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: true,
    requestHandlerTimeoutSecs: 2400,
    launchContext: { launchOptions: { headless: true, args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] } },
    async requestHandler({ page }) {
        await page.setExtraHTTPHeaders({ 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.6' });
        for (const city of cities) {
            if (total >= maxOutputRows) break;
            const wanted = isParis(city) ? 3 : 1;
            const checkedLimit = isParis(city) ? Math.max(15, maxStoresPerCityToCheck) : maxStoresPerCityToCheck;
            let candidates = [];
            try { candidates = await openCity(page, city); }
            catch (error) { log.warning(`${city}: ${error.message}`); continue; }
            if (isParis(city)) candidates.sort((a, b) => Number(isCentralParis(b.postal)) - Number(isCentralParis(a.postal)));
            let found = 0;
            for (const store of candidates.slice(0, checkedLimit)) {
                if (found >= wanted || total >= maxOutputRows) break;
                try {
                    if (!(await selectStore(page, city, store))) continue;
                    if (!(await productAvailable(page))) continue;
                    await Actor.pushData(row(city, store, await geocode(store.address)));
                    found += 1;
                    total += 1;
                } catch (error) { log.warning(`${city}/${store.postal}: ${error.message}`); }
            }
            log.info(`${city}: ${found} verified store(s).`);
        }
    }
});

await crawler.run([{ url: DIRECTORY_URL, uniqueKey: 'INTERMARCHE-SAM-BARTON-FR' }]);
log.info(`Finished with ${total} verified physical stores.`);
await Actor.exit();
