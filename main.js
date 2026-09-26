import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const STORES_URL = 'https://www.supermarchesmatch.fr/fr/magasins';
const PRODUCT_URL = 'https://www.supermarchesmatch.fr/fr/p/0843795/sam-barton-canadian-whisky-5-ans-40percent';
const EAN = '3147690052906';
const maxStoresToCheck = Math.max(1, Number(input.maxStoresToCheck ?? 150));
const maxOutputRows = Math.max(1, Number(input.maxOutputRows ?? 150));

function normalized(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();
}
const isParis = (value) => normalized(value) === 'paris';
const isCentralParis = (postal) => /^(7500[1-8])$/.test(String(postal ?? ''));

async function dismissDialogs(page) {
    for (const pattern of [/Tout accepter/i, /Accepter tout/i, /Continuer sans accepter/i, /J'ai compris/i]) {
        try {
            const button = page.locator('button, a').filter({ hasText: pattern }).first();
            if (await button.isVisible({ timeout: 800 })) await button.click({ timeout: 3000 });
        } catch {}
    }
    await page.evaluate(() => {
        document.querySelectorAll('#actito-push, .actito__backdrop').forEach((element) => element.remove());
        document.documentElement.style.overflow = 'auto';
        document.body.style.overflow = 'auto';
    }).catch(() => {});
}

async function goto(page, url) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (response && [403, 429].includes(response.status())) throw new Error(`HTTP ${response.status()}`);
    await dismissDialogs(page);
    await page.locator('body').waitFor({ state: 'visible', timeout: 20000 });
}

async function loadStores(page) {
    await goto(page, STORES_URL);
    const buttons = page.getByRole('button', { name: /Choisir ce magasin/i });
    await buttons.first().waitFor({ state: 'visible', timeout: 30000 });
    const stores = await buttons.evaluateAll((nodes) => nodes.map((node, buttonIndex) => {
            let parent = node.parentElement;
            while (parent && parent !== document.body) {
                const text = (parent.innerText || '').replace(/\r/g, '').trim();
                if (/\b\d{5}\b/.test(text) && text.length >= 20 && text.length <= 800) {
                    const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
                    const postal = text.match(/\b\d{5}\b/)?.[0] || '';
                    const postalLine = lines.find((x) => x.includes(postal)) || '';
                    const city = postalLine.replace(/^.*?\b\d{5}\b\s*/, '').trim();
                    const postalIndex = lines.indexOf(postalLine);
                    const street = postalIndex > 0 ? lines[postalIndex - 1] : '';
                    const name = lines.find((x) => !/Image|Choisir ce magasin|Voir le plan|Drive|Livraison|Click/i.test(x)) || city;
                    const raw = `${street} ${postalLine}`.trim();
                    const attrs = [node, parent, parent.parentElement].filter(Boolean)
                        .flatMap((element) => Array.from(element.attributes || []).map((a) => `${a.name}=${a.value}`)).join(' ');
                    const id = attrs.match(/(?:boutique|magasin|store)[^0-9]{0,8}(\d{1,6})/i)?.[1] || '';
                    return { buttonIndex, name, address: raw, postal, city, id };
                }
                parent = parent.parentElement;
            }
            return null;
        }).filter((item) => item?.postal && item?.city));
    return stores;
}

async function selectStore(page, target) {
    await goto(page, STORES_URL);
    const buttons = page.getByRole('button', { name: /Choisir ce magasin/i });
    await buttons.first().waitFor({ state: 'visible', timeout: 30000 });
    await dismissDialogs(page);
    if (target.buttonIndex >= await buttons.count()) return false;
    await buttons.nth(target.buttonIndex).click({ timeout: 5000, force: true, noWaitAfter: true });
    await page.waitForTimeout(1800);
    for (const pattern of [/Confirmer/i, /Continuer/i, /Choisir/i]) {
        try {
            const button = page.getByRole('button', { name: pattern }).last();
            if (await button.isVisible({ timeout: 800 })) await button.click({ timeout: 5000 });
        } catch {}
    }
    await page.waitForTimeout(1200);
    return true;
}

async function productAvailable(page) {
    await goto(page, PRODUCT_URL);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const correct = text.includes(EAN) && /Sam Barton/i.test(text) && /Canadian Whisky 5 ans/i.test(text);
    const unavailable = /indisponible|non disponible|épuisé|rupture/i.test(text);
    const asksStore = /Choisir un magasin|Sélectionner un magasin/i.test(text);
    const hasPrice = /\b\d{1,3}[,.]\d{2}\s*€/.test(text);
    const addButtons = page.getByRole('button', { name: /Ajouter au panier/i });
    let enabled = false;
    for (let i = 0; i < await addButtons.count(); i += 1) {
        if (await addButtons.nth(i).isEnabled().catch(() => false)) { enabled = true; break; }
    }
    return correct && !unavailable && !asksStore && hasPrice && enabled;
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

function makeRow(store, coordinates) {
    const now = new Date();
    const storeId = store.id || normalized(`${store.name}-${store.postal}`).replace(/ /g, '-');
    return {
        candidate_id: `match-fr-${EAN}-${storeId}`,
        product_id: '0843795',
        ean: EAN,
        product_name: 'Sam Barton Canadian Whisky 5 ans, 40 %, 70 cl',
        brand: 'Sam Barton',
        brand_owner_name: 'La Martiniquaise-Bardinet',
        brand_owner_country: 'FR',
        category: 'Food & Grocery',
        made_in_country: 'CA',
        origin_evidence_text: 'Authentique whisky canadien vieilli en fûts pendant cinq ans.',
        origin_evidence_url: PRODUCT_URL,
        retailer: 'Supermarchés Match',
        store_id: storeId,
        store_name: `Match ${store.name}`,
        address: store.address,
        postal_code: store.postal,
        city: store.city,
        country_code: 'FR',
        ...coordinates,
        availability_status: 'in_stock',
        availability_evidence_text: 'Enabled add-to-cart control and price displayed after selecting this physical Match store.',
        availability_evidence_url: PRODUCT_URL,
        product_url: PRODUCT_URL,
        physical_store_only: true,
        map_ready: coordinates.latitude !== null && coordinates.longitude !== null,
        checked_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 86400000).toISOString(),
        scraper_version: 'match-sam-barton-fr-1.0.0'
    };
}

const groups = String(input.proxyGroups ?? 'RESIDENTIAL').split(',').map((x) => x.trim()).filter(Boolean);
const proxyConfiguration = input.useApifyProxy === false ? undefined : await Actor.createProxyConfiguration({
    useApifyProxy: true,
    groups,
    countryCode: 'FR'
});
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
        let stores = await loadStores(page);
        log.info(`Loaded ${stores.length} Match stores.`);
        stores.sort((a, b) => Number(isCentralParis(b.postal)) - Number(isCentralParis(a.postal)));
        const cityCounts = new Map();
        for (const store of stores.slice(0, maxStoresToCheck)) {
            if (total >= maxOutputRows) break;
            const cityKey = normalized(store.city);
            const limit = isParis(store.city) ? 3 : 1;
            if ((cityCounts.get(cityKey) ?? 0) >= limit) continue;
            try {
                if (!(await selectStore(page, store))) continue;
                if (!(await productAvailable(page))) continue;
                await Actor.pushData(makeRow(store, await geocode(store.address)));
                cityCounts.set(cityKey, (cityCounts.get(cityKey) ?? 0) + 1);
                total += 1;
                log.info(`${store.city}: verified (${total} total).`);
            } catch (error) { log.warning(`${store.city}/${store.postal}: ${error.message}`); }
        }
    }
});

await crawler.run([{ url: STORES_URL, uniqueKey: 'MATCH-SAM-BARTON-FR' }]);
log.info(`Finished with ${total} verified physical stores.`);
await Actor.exit();
