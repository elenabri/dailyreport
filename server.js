require('dotenv').config();

const express = require('express');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;


const WB_TOKEN = process.env.WB_TOKEN;
if (!WB_TOKEN) {
    throw new Error(
        'Не задан WB_TOKEN. Создай .env: WB_TOKEN=ТВОЙ_ТОКЕН'
    );
}

app.use(express.static(__dirname));

let dashboardRunning = false;
let analyticsNextRequestAt = 0;


// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
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
// RATE LIMIT ANALYTICS
// ============================================================

async function waitAnalyticsLimit() {

    const wait =
        analyticsNextRequestAt - Date.now();

    if (wait > 0) {
        console.log(
            `Ждём WB Analytics: ${Math.ceil(wait / 1000)} сек.`
        );

        await sleep(wait);
    }
}


// ============================================================
// WB GET
// ============================================================

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
            response.headers.get('X-RateLimit-Retry');

        throw error;
    }

    return JSON.parse(text);
}


// ============================================================
// WB POST
// ============================================================

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
            response.headers.get('X-RateLimit-Retry');

        throw error;
    }

    return JSON.parse(text);
}


// ============================================================
// WB POST С RETRY
// ============================================================

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

            // Защита от слишком частых запросов
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

            console.log(
                `429. Ждём ${retryAfter} сек.`
            );

            analyticsNextRequestAt =
                Date.now() +
                retryAfter * 1000;

            await sleep(
                retryAfter * 1000
            );
        }
    }
}


// ============================================================
// 1. ЗАКАЗЫ
//
// Берём последние 30 дней.
// Это одновременно позволяет:
// - получить список товаров
// - показать продажи за 3 дня
// - заказы сегодня
// - заказы за 30 дней
// ============================================================

async function getOrders30Days(
    dateFrom,
    dateTo
) {

    console.log('');
    console.log('========================================');
    console.log('ЗАКАЗЫ 30 ДНЕЙ');
    console.log(`${dateFrom} -> ${dateTo}`);
    console.log('========================================');


    const url =
        'https://statistics-api.wildberries.ru/api/v1/supplier/orders' +
        `?dateFrom=${encodeURIComponent(dateFrom)}` +
        '&flag=0';


    const rows =
        await wbGet(url);


    console.log(
        `Получено строк: ${rows.length}`
    );


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


        // --------------------------------------------------------
        // Продажи / заказы
        // --------------------------------------------------------

        day.sales++;


        // --------------------------------------------------------
        // Цена продавца со скидкой
        // --------------------------------------------------------

        if (
            row.priceWithDisc != null
        ) {

            day.sellerPrice =
                Number(
                    row.priceWithDisc
                );
        }


        // --------------------------------------------------------
        // СПП
        // --------------------------------------------------------

        if (
            row.spp != null
        ) {

            day.spp =
                Number(
                    row.spp
                );
        }


        // --------------------------------------------------------
        // Цена покупателя
        // --------------------------------------------------------

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


    // Создаём отсутствующие дни

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


    console.log(
        `Уникальных товаров: ${result.length}`
    );


    return {
        products: result,
        dates
    };
}


// ============================================================
// 2. ОСТАТКИ
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


// ============================================================
// ЖДЁМ ОТЧЁТ ОСТАТКОВ
// ============================================================

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


        const report =
            data?.data?.[0];


        const status =
            report?.status;


        console.log(
            `STOCK ${i}/60: ${status}`
        );


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


// ============================================================
// СКАЧИВАЕМ ОСТАТКИ
// ============================================================

async function downloadStockReport(id) {

    const response =
        await fetch(

            'https://seller-analytics-api.wildberries.ru' +
            `/api/v2/nm-report/downloads/file/${id}`,

            {

                headers: {

                    Authorization:
                        WB_TOKEN

                }

            }
        );


    if (!response.ok) {

        const text =
            await response.text();

        throw new Error(
            `WB STOCK ${response.status}: ${text}`
        );
    }


    return Buffer.from(
        await response.arrayBuffer()
    );
}


// ============================================================
// CSV PARSER
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


// ============================================================
// СОБИРАЕМ ОСТАТКИ
// ============================================================

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


        // Название

        if (row.Name) {

            meta[nmId].name =
                row.Name;
        }


        // Артикул

        if (row.VendorCode) {

            meta[nmId].article =
                row.VendorCode;
        }


        // Даты

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


// ============================================================
// ПОЛУЧЕНИЕ ОСТАТКОВ
// ============================================================

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


    // --------------------------------------------------------
    // Иногда WB отдаёт ZIP
    // --------------------------------------------------------

    const isZip =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;


    if (isZip) {

        console.log(
            'Остатки: получен ZIP'
        );


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


    const rows =
        parseCSV(buffer);


    console.log(
        `Остатки CSV строк: ${rows.length}`
    );


    return buildStocks(rows);
}


// ============================================================
// 3. ПОИСКОВЫЕ ЗАПРОСЫ
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


    const currentTo =
        today;


    const pastFrom =
        addDays(
            currentFrom,
            -7
        );


    const pastTo =
        addDays(
            currentFrom,
            -1
        );


    const body = {

        currentPeriod: {

            start: currentFrom,

            end: currentTo

        },


        pastPeriod: {

            start: pastFrom,

            end: pastTo

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
    };


    const data =
        await wbPostRetry(

            'https://seller-analytics-api.wildberries.ru' +
            '/api/v2/search-report/product/search-texts',

            body

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
// 4. ПОЗИЦИЯ ТОВАРА
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


    const from =
        addDays(
            today,
            -6
        );


    const body = {

        period: {

            start: from,

            end: today

        },


        nmId:
            Number(nmId),


        searchTexts

    };


    const data =
        await wbPostRetry(

            'https://seller-analytics-api.wildberries.ru' +
            '/api/v2/search-report/product/orders',

            body

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


    // Если WB отдаёт несколько строк,
    // усредняем позиции.

    const positions =
        todayRows
            .map(
                x =>
                    Number(x.avgPosition)
            )
            .filter(
                x =>
                    Number.isFinite(x) &&
                    x > 0
            );


    if (!positions.length) {
        return null;
    }


    const average =
        positions.reduce(
            (a, b) => a + b,
            0
        ) / positions.length;


    return average;
}


// ============================================================
// 5. ФИНАЛЬНЫЕ ДАННЫЕ
// ============================================================

async function buildDashboard() {

    const today =
        getMoscowToday();


    // 30 календарных дней
    const dateFrom =
        addDays(
            today,
            -29
        );


    console.log('');
    console.log('========================================');
    console.log('WB DASHBOARD');
    console.log(`${dateFrom} -> ${today}`);
    console.log('========================================');


    // --------------------------------------------------------
    // ЗАКАЗЫ
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // ОСТАТКИ
    // --------------------------------------------------------

    const stocks =
        await getStocks(
            dateFrom,
            today
        );


    const meta =
        stocks._meta || {};


    // --------------------------------------------------------
    // Последние 3 дня
    // --------------------------------------------------------

    const last3 =
        dates.slice(-3);


    // --------------------------------------------------------
    // Последние 7 дней
    // --------------------------------------------------------

    const last7 =
        dates.slice(-7);


    const result = [];


    // --------------------------------------------------------
    // ПО ТОВАРАМ
    // --------------------------------------------------------

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


        // ----------------------------------------------------
        // Название и артикул из отчёта остатков
        // ----------------------------------------------------

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


        // ----------------------------------------------------
        // ПРОДАЖИ ЗА 7 ДНЕЙ
        // ----------------------------------------------------

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


        // ----------------------------------------------------
        // СРЕДНИЕ ПРОДАЖИ В ДЕНЬ
        // ----------------------------------------------------

        const averageSales7 =
            sales7 / 7;


        // ----------------------------------------------------
        // ОСТАТОК СЕГОДНЯ
        // ----------------------------------------------------

        const stockToday =
            Number(
                stock[today] || 0
            );


        // ----------------------------------------------------
        // ХВАТИТ НА
        // ----------------------------------------------------

        const daysLeft =
            averageSales7 > 0

                ? stockToday /
                  averageSales7

                : null;


        // ----------------------------------------------------
        // ПОЗИЦИЯ
        // ----------------------------------------------------

        let positionToday =
            null;


        try {

            console.log(
                `Позиция ${i + 1}/${products.length}: ${nmId}`
            );


            positionToday =
                await getTodayPosition(
                    nmId,
                    today
                );


            // Дополнительная пауза
            await sleep(3000);

        } catch (error) {

            console.error(
                `Позиция ${nmId}:`,
                error.message
            );


            positionToday =
                null;


            await sleep(5000);
        }


        // ----------------------------------------------------
        // 3 ДНЯ
        // ----------------------------------------------------

        const days =
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
            );


        result.push({

            nmId,

            article:
                product.article || '',

            name:
                product.name || '',


            // Сегодня

            todayOrders:
                Number(
                    product.days[today]
                        ?.sales || 0
                ),


            // 30 дней

            orders30:
                Number(
                    product.orders30 || 0
                ),


            // Остаток

            stockToday,


            // Средние продажи

            averageSales7,


            // Хватит на

            daysLeft,


            // Позиция

            positionToday,


            // 3 дня

            days

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
// API
// ============================================================

app.get(
    '/api/dashboard',
    async (req, res) => {

        if (dashboardRunning) {

            return res
                .status(409)
                .json({

                    success: false,

                    error:
                        'Данные уже обновляются. Дождитесь завершения.'

                });
        }


        dashboardRunning =
            true;


        try {

            const data =
                await buildDashboard();


            res.json({

                success: true,

                ...data

            });

        } catch (error) {

            console.error('');
            console.error(
                'DASHBOARD ERROR:',
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        error.message

                });

        } finally {

            dashboardRunning =
                false;
        }
    }
);


// ============================================================
// SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log('');
        console.log(
            '========================================'
        );

        console.log(
            `WB Dashboard: http://localhost:${PORT}`
        );

        console.log(
            '========================================'
        );
    }
);
