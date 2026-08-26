const AdmZip = require('adm-zip');
const crypto = require('crypto');

const WB_TOKEN = process.env.WB_TOKEN;

if (!WB_TOKEN) {
    throw new Error('WB_TOKEN не задан в Vercel Environment Variables');
}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function getMoscowToday() {

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());

    const x = {};

    for (const p of parts) {
        x[p.type] = p.value;
    }

    return `${x.year}-${x.month}-${x.day}`;
}


function addDays(date, days) {

    const d = new Date(`${date}T12:00:00`);

    d.setDate(d.getDate() + days);

    return d.toISOString().slice(0, 10);
}


function getDates(from, to) {

    const result = [];

    let d = new Date(`${from}T12:00:00`);
    const end = new Date(`${to}T12:00:00`);

    while (d <= end) {

        result.push(
            d.toISOString().slice(0, 10)
        );

        d.setDate(d.getDate() + 1);
    }

    return result;
}


// ============================================================
// WB
// ============================================================

let analyticsNextRequestAt = 0;


async function waitAnalyticsLimit() {

    const wait =
        analyticsNextRequestAt - Date.now();

    if (wait > 0) {
        await sleep(wait);
    }
}


async function wbGet(url) {

    const response = await fetch(url, {

        headers: {
            Authorization: WB_TOKEN,
            Accept: 'application/json'
        }

    });

    const text = await response.text();

    if (!response.ok) {

        const error =
            new Error(
                `WB GET ${response.status}: ${text}`
            );

        error.status = response.status;

        error.retryAfter =
            response.headers.get(
                'X-RateLimit-Retry'
            );

        throw error;
    }

    return JSON.parse(text);
}


async function wbPost(url, body) {

    const response = await fetch(url, {

        method: 'POST',

        headers: {
            Authorization: WB_TOKEN,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },

        body: JSON.stringify(body)

    });

    const text = await response.text();

    if (!response.ok) {

        const error =
            new Error(
                `WB POST ${response.status}: ${text}`
            );

        error.status = response.status;

        error.retryAfter =
            response.headers.get(
                'X-RateLimit-Retry'
            );

        throw error;
    }

    return JSON.parse(text);
}


async function wbPostRetry(
    url,
    body,
    maxAttempts = 5
) {

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {

        await waitAnalyticsLimit();

        try {

            const result =
                await wbPost(
                    url,
                    body
                );

            analyticsNextRequestAt =
                Date.now() + 1500;

            return result;

        } catch (error) {

            if (
                error.status !== 429 ||
                attempt >= maxAttempts
            ) {
                throw error;
            }

            let retryAfter =
                Number(error.retryAfter);

            if (
                !Number.isFinite(retryAfter) ||
                retryAfter < 1
            ) {
                retryAfter = 20;
            }

            await sleep(
                retryAfter * 1000
            );
        }
    }
}


// ============================================================
// ЗАКАЗЫ 30 ДНЕЙ
// ============================================================

async function getOrders30Days(
    dateFrom,
    dateTo
) {

    const url =
        'https://statistics-api.wildberries.ru/api/v1/supplier/orders' +
        `?dateFrom=${encodeURIComponent(dateFrom)}` +
        '&flag=0';


    const rows =
        await wbGet(url);


    const dates =
        getDates(
            dateFrom,
            dateTo
        );


    const products = {};


    for (const row of rows) {

        const nmId =
            Number(row.nmId);


        if (
            !Number.isFinite(nmId) ||
            nmId <= 0
        ) {
            continue;
        }


        const date =
            String(row.date || '')
                .slice(0, 10);


        if (!dates.includes(date)) {
            continue;
        }


        if (!products[nmId]) {

            products[nmId] = {

                nmId,

                article:
                    row.supplierArticle ||
                    row.vendorCode ||
                    '',

                name: '',

                days: {}

            };
        }


        if (!products[nmId].days[date]) {

            products[nmId].days[date] = {

                sales: 0,

                buyerPrice: null,

                spp: null,

                sellerPrice: null

            };
        }


        const day =
            products[nmId].days[date];


        day.sales++;


        if (
            row.priceWithDisc != null
        ) {

            day.sellerPrice =
                Number(
                    row.priceWithDisc
                );
        }


        if (
            row.spp != null
        ) {

            day.spp =
                Number(
                    row.spp
                );
        }


        if (
            row.finishedPrice != null
        ) {

            day.buyerPrice =
                Number(
                    row.finishedPrice
                );
        }
    }


    const result =
        Object.values(products);


    for (const product of result) {

        for (const date of dates) {

            if (!product.days[date]) {

                product.days[date] = {

                    sales: 0,

                    buyerPrice: null,

                    spp: null,

                    sellerPrice: null

                };
            }
        }


        product.orders30 =
            dates.reduce(

                (sum, date) =>

                    sum +
                    Number(
                        product.days[date]
                            ?.sales || 0
                    ),

                0
            );
    }


    return {
        products: result,
        dates
    };
}


// ============================================================
// ОСТАТКИ
// ============================================================

async function createStockReport(
    dateFrom,
    dateTo
) {

    const id =
        crypto.randomUUID();


    await wbPost(

        'https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads',

        {

            id,

            reportType:
                'STOCK_HISTORY_DAILY_CSV',

            userReportName:
                `Dashboard ${dateFrom}-${dateTo}`,

            params: {

                currentPeriod: {

                    start: dateFrom,

                    end: dateTo

                },

                stockType: 'wb',

                skipDeletedNm: false

            }
        }
    );


    return id;
}


async function waitStockReport(id) {

    for (
        let i = 1;
        i <= 60;
        i++
    ) {

        const data =
            await wbGet(

                'https://seller-analytics-api.wildberries.ru' +
                '/api/v2/nm-report/downloads' +
                `?filter[downloadIds]=${id}`

            );


        const status =
            data?.data?.[0]?.status;


        if (
            status === 'SUCCESS'
        ) {
            return;
        }


        if (
            status === 'FAILED' ||
            status === 'ERROR'
        ) {

            throw new Error(
                `STOCK REPORT ${status}`
            );
        }


        await sleep(2000);
    }


    throw new Error(
        'Отчёт остатков не сформировался'
    );
}


async function downloadStockReport(id) {

    const response =
        await fetch(

            'https://seller-analytics-api.wildberries.ru' +
            `/api/v2/nm-report/downloads/file/${id}`,

            {
                headers: {
                    Authorization: WB_TOKEN
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `WB STOCK ${response.status}: ${
                await response.text()
            }`
        );
    }


    return Buffer.from(
        await response.arrayBuffer()
    );
}


// ============================================================
// CSV
// ============================================================

function parseCSV(buffer) {

    let text =
        buffer
            .toString('utf8')
            .replace(/^\uFEFF/, '');


    const lines =
        text
            .split(/\r?\n/)
            .filter(
                x => x.trim()
            );


    if (!lines.length) {
        return [];
    }


    function parseLine(line) {

        const result = [];

        let value = '';

        let quoted = false;


        for (
            let i = 0;
            i < line.length;
            i++
        ) {

            const c =
                line[i];


            if (c === '"') {

                if (
                    quoted &&
                    line[i + 1] === '"'
                ) {

                    value += '"';

                    i++;

                } else {

                    quoted =
                        !quoted;
                }

                continue;
            }


            if (
                c === ',' &&
                !quoted
            ) {

                result.push(value);

                value = '';

                continue;
            }


            value += c;
        }


        result.push(value);

        return result;
    }


    const headers =
        parseLine(
            lines[0]
        );


    return lines
        .slice(1)
        .map(line => {

            const values =
                parseLine(line);

            const row = {};


            headers.forEach(
                (h, i) => {

                    row[h] =
                        values[i] ?? '';

                }
            );


            return row;
        });
}


function buildStocks(rows) {

    const stocks = {};

    const meta = {};


    for (const row of rows) {

        const nmId =
            Number(

                String(
                    row.NmID ||
                    row.nmID ||
                    row.nmId ||
                    ''
                )
                    .replace(/\s/g, '')
            );


        if (
            !Number.isFinite(nmId) ||
            nmId <= 0
        ) {
            continue;
        }


        if (!stocks[nmId]) {
            stocks[nmId] = {};
        }


        if (!meta[nmId]) {
            meta[nmId] = {};
        }


        if (row.Name) {

            meta[nmId].name =
                row.Name;
        }


        if (row.VendorCode) {

            meta[nmId].article =
                row.VendorCode;
        }


        for (
            const key of
            Object.keys(row)
        ) {

            if (
                !/^\d{2}\.\d{2}\.\d{4}$/
                    .test(key)
            ) {
                continue;
            }


            const [
                day,
                month,
                year
            ] =
                key.split('.');


            const date =
                `${year}-${month}-${day}`;


            const value =
                Number(

                    String(
                        row[key] ?? 0
                    )
                        .replace(/\s/g, '')
                        .replace(',', '.')
                );


            stocks[nmId][date] =
                Number.isFinite(value)
                    ? value
                    : 0;
        }
    }


    stocks._meta =
        meta;


    return stocks;
}


async function getStocks(
    dateFrom,
    dateTo
) {

    const reportId =
        await createStockReport(
            dateFrom,
            dateTo
        );


    await waitStockReport(
        reportId
    );


    let buffer =
        await downloadStockReport(
            reportId
        );


    const isZip =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;


    if (isZip) {

        const zip =
            new AdmZip(buffer);


        const entry =
            zip
                .getEntries()
                .find(
                    x =>
                        x.entryName
                            .toLowerCase()
                            .endsWith('.csv')
                );


        if (!entry) {

            throw new Error(
                'CSV внутри ZIP не найден'
            );
        }


        buffer =
            entry.getData();
    }


    return buildStocks(
        parseCSV(buffer)
    );
}


// ============================================================
// ПОИСКОВЫЕ ЗАПРОСЫ
// ============================================================

async function getSearchTexts(
    nmId,
    today
) {

    const currentFrom =
        addDays(
            today,
            -6
        );


    const data =
        await wbPostRetry(

            'https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts',

            {

                currentPeriod: {

                    start: currentFrom,

                    end: today

                },

                pastPeriod: {

                    start:
                        addDays(
                            currentFrom,
                            -7
                        ),

                    end:
                        addDays(
                            currentFrom,
                            -1
                        )

                },

                nmIds: [
                    Number(nmId)
                ],

                topOrderBy:
                    'orders',

                includeSubstitutedSKUs:
                    true,

                includeSearchTexts:
                    true,

                orderBy: {

                    field:
                        'avgPosition',

                    mode:
                        'asc'

                },

                limit: 30

            }
        );


    return (
        data?.data?.items || []
    )
        .map(
            x =>
                x.text ||
                x.searchText ||
                x.query
        )
        .filter(Boolean);
}


// ============================================================
// ПОЗИЦИЯ
// ============================================================

async function getTodayPosition(
    nmId,
    today
) {

    const searchTexts =
        await getSearchTexts(
            nmId,
            today
        );


    if (!searchTexts.length) {
        return null;
    }


    const data =
        await wbPostRetry(

            'https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/orders',

            {

                period: {

                    start:
                        addDays(
                            today,
                            -6
                        ),

                    end: today

                },

                nmId:
                    Number(nmId),

                searchTexts

            }
        );


    const total =
        data?.data?.total || [];


    const todayRows =
        total.filter(
            item =>
                String(item.dt || '')
                    .slice(0, 10) === today
        );


    if (!todayRows.length) {
        return null;
    }


    const positions =
        todayRows
            .map(
                x =>
                    Number(
                        x.avgPosition
                    )
            )
            .filter(
                x =>
                    Number.isFinite(x) &&
                    x > 0
            );


    if (!positions.length) {
        return null;
    }


    return (
        positions.reduce(
            (a, b) => a + b,
            0
        ) / positions.length
    );
}


// ============================================================
// DASHBOARD
// ============================================================

async function buildDashboard() {

    const today =
        getMoscowToday();


    const dateFrom =
        addDays(
            today,
            -29
        );


    const ordersData =
        await getOrders30Days(
            dateFrom,
            today
        );


    const products =
        ordersData.products;


    const dates =
        ordersData.dates;


    if (!products.length) {

        return {

            updatedAt:
                new Date().toISOString(),

            period: {

                from: dateFrom,

                to: today

            },

            products: []

        };
    }


    const stocks =
        await getStocks(
            dateFrom,
            today
        );


    const meta =
        stocks._meta || {};


    const last3 =
        dates.slice(-3);


    const last7 =
        dates.slice(-7);


    const result = [];


    for (
        let i = 0;
        i < products.length;
        i++
    ) {

        const product =
            products[i];


        const nmId =
            Number(product.nmId);


        const stock =
            stocks[nmId] || {};


        if (
            meta[nmId]?.name
        ) {

            product.name =
                meta[nmId].name;
        }


        if (
            meta[nmId]?.article
        ) {

            product.article =
                meta[nmId].article;
        }


        const sales7 =
            last7.reduce(

                (sum, date) =>

                    sum +
                    Number(
                        product.days[date]
                            ?.sales || 0
                    ),

                0
            );


        const averageSales7 =
            sales7 / 7;


        const stockToday =
            Number(
                stock[today] || 0
            );


        const daysLeft =
            averageSales7 > 0
                ? stockToday / averageSales7
                : null;


        let positionToday =
            null;


        try {

            positionToday =
                await getTodayPosition(
                    nmId,
                    today
                );

        } catch (error) {

            console.error(
                `Position ${nmId}:`,
                error.message
            );

        }


        result.push({

            nmId,

            article:
                product.article || '',

            name:
                product.name || '',

            todayOrders:
                Number(
                    product.days[today]
                        ?.sales || 0
                ),

            orders30:
                Number(
                    product.orders30 || 0
                ),

            stockToday,

            averageSales7,

            daysLeft,

            positionToday,

            days:
                last3.map(
                    date => {

                        const d =
                            product.days[date] || {};


                        return {

                            date,

                            buyerPrice:
                                d.buyerPrice,

                            spp:
                                d.spp,

                            sellerPrice:
                                d.sellerPrice,

                            sales:
                                Number(
                                    d.sales || 0
                                )

                        };

                    }
                )

        });
    }


    return {

        updatedAt:
            new Date().toISOString(),

        period: {

            from: dateFrom,

            to: today

        },

        products:
            result

    };
}


// ============================================================
// VERCEL HANDLER
// ============================================================

module.exports = async function handler(
    req,
    res
) {

    try {

        const data =
            await buildDashboard();


        return res.status(200).json({

            success: true,

            ...data

        });

    } catch (error) {

        console.error(
            'DASHBOARD ERROR:',
            error
        );


        return res.status(500).json({

            success: false,

            error:
                error.message

        });
    }
};