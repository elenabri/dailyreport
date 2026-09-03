require('dotenv').config();

const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const path = require('path');

const app = express();

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);


// ============================================================
// ГЛАВНАЯ СТРАНИЦА
// ============================================================

app.get('/', (req, res) => {
    res.sendFile(
        path.join(__dirname, 'index.html')
    );
});


// ============================================================
// WB
// ============================================================

const WB_TOKEN ='eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYwMzAydjEiLCJ0eXAiOiJKV1QifQ.eyJhY2MiOjMsImVudCI6MSwiZXhwIjoxNzk1ODE3NTIwLCJmb3IiOiJzZWxmIiwiaWQiOiIwMTllNzMzOC0yOTMyLTcyZTQtOWJiMy0wNTQ0OTA3OTdiOTEiLCJpaWQiOjExNzcyNzc0LCJvaWQiOjEyOTk2MSwicyI6ODE2NjIsInNpZCI6IjljYmM3N2U3LWNjMzEtNDgwMC1hMzk2LWYxZmViZjM2MjEyZSIsInQiOmZhbHNlLCJ1aWQiOjExNzcyNzc0fQ.FSug6W66Kdm_ej_1o8lpkDYhSjbTDM2GceayIDb-nocwDXVllJWkb0d89TAXp6_Gz-FyYh4-puiDuAJfpZE6yA';

if (!WB_TOKEN) {
    throw new Error(
        'Не задан WB_TOKEN. Добавь WB_TOKEN в Environment Variables Vercel.'
    );
}


// ============================================================
// МОЙСКЛАД
// ============================================================

const MS_TOKEN = '7b74e255c703ea5eb74c3017a8de663a594add33';

if (!MS_TOKEN) {
    console.warn(
        'WARNING: MS_TOKEN не задан. Себестоимость МойСклад недоступна.'
    );
}

const MS_API = MS_TOKEN
    ? axios.create({
        baseURL:
            'https://api.moysklad.ru/api/remap/1.2',

        timeout: 60000,

        headers: {
            Authorization:
                `Bearer ${MS_TOKEN}`,

            Accept:
                'application/json;charset=utf-8',

            'Content-Type':
                'application/json'
        }
    })
    : null;


// ============================================================
// ТИП ЦЕНЫ МойСклад
// ============================================================
//
// Именно:
// «Себестоимость без НДС»
//
// ID найден в данных МойСклад:
// 32aeeb71-7b95-11f1-0a80-067e000fa1e9
//
// НЕ используем buyPrice.
// ============================================================

const MS_COST_PRICE_TYPE_ID =
    '32aeeb71-7b95-11f1-0a80-067e000fa1e9';


app.use(
    express.json()
);


// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


// ============================================================
// СЕГОДНЯ ПО МОСКВЕ
// ============================================================

function getMoscowToday() {

    const parts =
        new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone:
                    'Europe/Moscow',

                year:
                    'numeric',

                month:
                    '2-digit',

                day:
                    '2-digit'
            }
        ).formatToParts(
            new Date()
        );

    const x = {};

    for (const p of parts) {
        x[p.type] = p.value;
    }

    return `${x.year}-${x.month}-${x.day}`;
}


// ============================================================
// ДОБАВИТЬ ДНИ
// ============================================================

function addDays(
    date,
    days
) {

    const d =
        new Date(
            `${date}T12:00:00`
        );

    d.setDate(
        d.getDate() + days
    );

    return d
        .toISOString()
        .slice(0, 10);
}


// ============================================================
// СПИСОК ДАТ
// ============================================================

function getDates(
    from,
    to
) {

    const result = [];

    let d =
        new Date(
            `${from}T12:00:00`
        );

    const end =
        new Date(
            `${to}T12:00:00`
        );

    while (d <= end) {

        result.push(
            d
                .toISOString()
                .slice(0, 10)
        );

        d.setDate(
            d.getDate() + 1
        );
    }

    return result;
}


// ============================================================
// RATE LIMIT ANALYTICS
// ============================================================

let analyticsNextRequestAt = 0;


async function waitAnalyticsLimit() {

    const wait =
        analyticsNextRequestAt -
        Date.now();

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

async function wbGet(
    url,
    maxAttempts = 5
) {

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {

        try {

            console.log(
                `WB GET ${attempt}/${maxAttempts}: ${url}`
            );

            const response =
                await fetch(
                    url,
                    {
                        method:
                            'GET',

                        headers: {
                            Authorization:
                                WB_TOKEN,

                            Accept:
                                'application/json'
                        },

                        signal:
                            AbortSignal.timeout(
                                60000
                            )
                    }
                );

            const text =
                await response.text();

            if (!response.ok) {

                const error =
                    new Error(
                        `WB GET ${response.status}: ${text}`
                    );

                error.status =
                    response.status;

                error.retryAfter =
                    response.headers.get(
                        'X-RateLimit-Retry'
                    );

                if (
                    response.status === 429 &&
                    attempt < maxAttempts
                ) {

                    let retryAfter =
                        Number(
                            error.retryAfter
                        );

                    if (
                        !Number.isFinite(
                            retryAfter
                        ) ||
                        retryAfter < 1
                    ) {
                        retryAfter = 20;
                    }

                    await sleep(
                        retryAfter * 1000
                    );

                    continue;
                }

                throw error;
            }

            try {

                return JSON.parse(text);

            } catch {

                throw new Error(
                    `WB GET вернул не JSON:\n${text.slice(0, 1000)}`
                );
            }

        } catch (error) {

            const networkError =
                error?.cause?.code ||
                error?.code;

            const isRetryable =
                networkError === 'ECONNRESET' ||
                networkError === 'ETIMEDOUT' ||
                networkError === 'ECONNREFUSED' ||
                networkError === 'ENETUNREACH' ||
                networkError === 'EAI_AGAIN' ||
                error?.name === 'TypeError' ||
                error?.name === 'AbortError';

            if (
                !isRetryable ||
                attempt >= maxAttempts
            ) {
                throw error;
            }

            const waitSeconds =
                Math.pow(
                    2,
                    attempt
                );

            console.log(
                `WB GET ошибка: ${
                    networkError ||
                    error.message
                }`
            );

            console.log(
                `Повтор через ${waitSeconds} сек.`
            );

            await sleep(
                waitSeconds * 1000
            );
        }
    }

    throw new Error(
        `WB GET не удалось выполнить после ${maxAttempts} попыток`
    );
}


// ============================================================
// WB POST
// ============================================================

async function wbPost(
    url,
    body
) {

    const response =
        await fetch(
            url,
            {
                method:
                    'POST',

                headers: {
                    Authorization:
                        WB_TOKEN,

                    'Content-Type':
                        'application/json',

                    Accept:
                        'application/json'
                },

                body:
                    JSON.stringify(body),

                signal:
                    AbortSignal.timeout(
                        60000
                    )
            }
        );

    const text =
        await response.text();

    if (!response.ok) {

        const error =
            new Error(
                `WB POST ${response.status}: ${text}`
            );

        error.status =
            response.status;

        error.retryAfter =
            response.headers.get(
                'X-RateLimit-Retry'
            );

        throw error;
    }

    try {

        return JSON.parse(text);

    } catch {

        throw new Error(
            `WB POST вернул не JSON:\n${text.slice(0, 1000)}`
        );
    }
}


// ============================================================
// WB POST RETRY
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
                Number(
                    error.retryAfter
                );

            if (
                !Number.isFinite(
                    retryAfter
                ) ||
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
// ============================================================
// РЕКЛАМА WB
// ============================================================
// ============================================================

async function getPromotionStats(
    dateFrom,
    dateTo
) {

    console.log('');
    console.log(
        '========================================'
    );

    console.log(
        'ПОЛУЧАЕМ РЕКЛАМУ WB'
    );

    console.log(
        `${dateFrom} -> ${dateTo}`
    );

    console.log(
        '========================================'
    );


    const promotionUrl =
        'https://advert-api.wildberries.ru/adv/v1/promotion/count';


    const promotionResponse =
        await wbGet(
            promotionUrl
        );


    const groups =
        Array.isArray(
            promotionResponse?.adverts
        )
            ? promotionResponse.adverts
            : [];


    const threeDaysAgo =
        Date.now() -
        3 * 24 * 60 * 60 * 1000;


    const uniqueIds =
        new Set();


    for (
        const group of groups
    ) {

        const status =
            Number(
                group?.status
            );


        const list =
            Array.isArray(
                group?.advert_list
            )
                ? group.advert_list
                : [];


        for (
            const advert of list
        ) {

            const advertId =
                Number(
                    advert?.advertId
                );


            if (
                !Number.isFinite(
                    advertId
                ) ||
                advertId <= 0
            ) {
                continue;
            }


            if (
                status === 9
            ) {

                uniqueIds.add(
                    advertId
                );

                continue;
            }


            const changeTime =
                advert?.changeTime
                    ? new Date(
                        advert.changeTime
                    ).getTime()
                    : NaN;


            if (
                Number.isFinite(
                    changeTime
                ) &&
                changeTime >=
                    threeDaysAgo
            ) {

                uniqueIds.add(
                    advertId
                );
            }
        }
    }


    const campaignIds =
        [...uniqueIds];


    console.log(
        'Всего рекламных кампаний:',
        campaignIds.length
    );


    if (
        !campaignIds.length
    ) {
        return {};
    }


    const result = {};


    for (
        let i = 0;
        i < campaignIds.length;
        i += 50
    ) {

        const batch =
            campaignIds.slice(
                i,
                i + 50
            );


        console.log(
            `FULLSTATS ${
                i + 1
            }-${
                Math.min(
                    i + 50,
                    campaignIds.length
                )
            } из ${
                campaignIds.length
            }`
        );


        const url =
            'https://advert-api.wildberries.ru/adv/v3/fullstats' +
            `?ids=${batch.join(',')}` +
            `&beginDate=${dateFrom}` +
            `&endDate=${dateTo}`;


        const stats =
            await wbGet(
                url
            );


        if (
            !Array.isArray(
                stats
            )
        ) {
            continue;
        }


        for (
            const campaign of stats
        ) {

            const days =
                Array.isArray(
                    campaign?.days
                )
                    ? campaign.days
                    : [];


            for (
                const day of days
            ) {

                const date =
                    String(
                        day?.date || ''
                    ).slice(
                        0,
                        10
                    );


                if (!date) {
                    continue;
                }


                const apps =
                    Array.isArray(
                        day?.apps
                    )
                        ? day.apps
                        : [];


                for (
                    const appStats of apps
                ) {

                    const nms =
                        Array.isArray(
                            appStats?.nms
                        )
                            ? appStats.nms
                            : [];


                    for (
                        const nm of nms
                    ) {

                        const nmId =
                            Number(
                                nm?.nmId
                            );


                        if (!nmId) {
                            continue;
                        }


                        if (
                            !result[nmId]
                        ) {
                            result[nmId] = {};
                        }


                        if (
                            !result[nmId][date]
                        ) {

                            result[nmId][date] = {
                                views: 0,
                                clicks: 0,
                                atbs: 0,
                                spend: 0
                            };
                        }


                        const target =
                            result[nmId][date];


                        target.views +=
                            Number(
                                nm?.views || 0
                            );


                        target.clicks +=
                            Number(
                                nm?.clicks || 0
                            );


                        target.atbs +=
                            Number(
                                nm?.atbs || 0
                            );


                        target.spend +=
                            Number(
                                nm?.sum || 0
                            );
                    }
                }
            }
        }


        if (
            i + 50 <
            campaignIds.length
        ) {

            console.log(
                'Пауза 21 сек перед следующим FULLSTATS...'
            );

            await sleep(
                21000
            );
        }
    }


    for (
        const nmId of Object.keys(
            result
        )
    ) {

        for (
            const date of Object.keys(
                result[nmId]
            )
        ) {

            const item =
                result[nmId][date];


            item.spend =
                Number(
                    item.spend.toFixed(2)
                );


            item.cpm =
                item.views > 0
                    ? Number(
                        (
                            item.spend /
                            item.views *
                            1000
                        ).toFixed(2)
                    )
                    : 0;
        }
    }


    return result;
}


// ============================================================
// ТЕКУЩИЕ ЦЕНЫ ПРОДАВЦА
// ============================================================

async function getCurrentSellerPrices(
    nmIds
) {

    const url =
        'https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter' +
        '?limit=1000';


    const response =
        await fetch(
            url,
            {
                method:
                    'GET',

                headers: {
                    Authorization:
                        WB_TOKEN,

                    Accept:
                        'application/json'
                },

                signal:
                    AbortSignal.timeout(
                        60000
                    )
            }
        );


    const text =
        await response.text();


    if (!response.ok) {

        throw new Error(
            `WB Seller Price ${response.status}: ${text}`
        );
    }


    let data;

    try {

        data =
            JSON.parse(text);

    } catch {

        throw new Error(
            `WB Seller API вернул не JSON:\n${text.slice(0, 1000)}`
        );
    }


    const goods =
        data?.data?.listGoods || [];


    const ourIds =
        new Set(
            nmIds.map(Number)
        );


    const prices = {};


    for (
        const product of goods
    ) {

        const nmId =
            Number(
                product.nmID
            );


        if (
            !ourIds.has(nmId)
        ) {
            continue;
        }


        let discountedPrice =
            null;


        for (
            const size of
            product.sizes || []
        ) {

            if (
                size?.discountedPrice != null
            ) {

                discountedPrice =
                    Number(
                        size.discountedPrice
                    );

                break;
            }
        }


        if (
            discountedPrice != null &&
            Number.isFinite(
                discountedPrice
            )
        ) {

            prices[nmId] =
                discountedPrice;
        }
    }


    return prices;
}


// ============================================================
// СЕБЕСТОИМОСТЬ ИЗ МОЙСКЛАДА
// ============================================================
//
// ВАЖНО:
//
// Получаем товар по его code.
//
// Затем смотрим salePrices.
//
// Берём только:
//
// «Себестоимость без НДС»
//
// НЕ buyPrice.
// ============================================================

async function getMoySkladCosts(
    products
) {

    const costs = {};


    if (!MS_API) {

        console.warn(
            'MS_TOKEN не задан — себестоимость МойСклад недоступна'
        );

        return costs;
    }


    const uniqueCodes =
        [
            ...new Set(
                products
                    .map(
                        product =>
                            String(
                                product.article || ''
                            ).trim()
                    )
                    .filter(Boolean)
            )
        ];


    console.log('');
    console.log(
        '========================================'
    );

    console.log(
        'ПОЛУЧАЕМ СЕБЕСТОИМОСТЬ ИЗ МОЙСКЛАДА'
    );

    console.log(
        `Кодов товаров: ${uniqueCodes.length}`
    );

    console.log(
        '========================================'
    );


    for (
        const code of uniqueCodes
    ) {

        try {

            const response =
                await MS_API.get(
                    '/entity/product',
                    {
                        params: {
                            filter:
                                `code=${code}`,

                            limit:
                                1
                        }
                    }
                );


            const rows =
                response.data?.rows || [];


            if (
                !rows.length
            ) {

                console.warn(
                    `МойСклад: товар не найден по code=${code}`
                );

                continue;
            }


            const msProduct =
                rows[0];


            const salePrices =
                Array.isArray(
                    msProduct.salePrices
                )
                    ? msProduct.salePrices
                    : [];


            // ----------------------------------------------------
            // СНАЧАЛА ИЩЕМ ПО ID
            // ----------------------------------------------------

            let costPrice =
                salePrices.find(
                    price =>
                        price?.priceType?.id ===
                        MS_COST_PRICE_TYPE_ID
                );


            // ----------------------------------------------------
            // ЕСЛИ ID НЕ НАШЛИ —
            // ИЩЕМ ПО НАЗВАНИЮ
            // ----------------------------------------------------

            if (
                !costPrice
            ) {

                costPrice =
                    salePrices.find(
                        price =>
                            String(
                                price?.priceType?.name || ''
                            ).trim() ===
                            'Себестоимость без НДС'
                    );
            }


            if (
                costPrice?.value != null
            ) {

                // МойСклад хранит денежные значения
                // в минимальных единицах.
                //
                // Поэтому:
                //
                // 4205 -> 42.05 ₽

                const cost =
                    Number(
                        costPrice.value
                    ) / 100;


                if (
                    Number.isFinite(
                        cost
                    )
                ) {

                    costs[code] =
                        cost;


                    console.log(
                        `МойСклад ${code}: ${cost} ₽`
                    );
                }

            } else {

                console.warn(
                    `МойСклад: у ${code} нет цены «Себестоимость без НДС»`
                );
            }


        } catch (error) {

            console.error(
                `МойСклад ${code} ERROR:`,
                error.response?.data ||
                error.message
            );
        }
    }


    console.log(
        `Себестоимость получена: ${
            Object.keys(costs).length
        }/${uniqueCodes.length}`
    );


    return costs;
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


    console.log('');
    console.log(
        '========================================'
    );

    console.log(
        'WB DASHBOARD'
    );

    console.log(
        `${dateFrom} -> ${today}`
    );

    console.log(
        '========================================'
    );


    // ========================================================
    // ЗАКАЗЫ
    // ========================================================

    const ordersData =
        await getOrders30Days(
            dateFrom,
            today
        );


    const products =
        ordersData.products;


    const dates =
        ordersData.dates;


    if (
        !products.length
    ) {

        return {
            updatedAt:
                new Date().toISOString(),

            period: {
                from:
                    dateFrom,

                to:
                    today
            },

            products:
                []
        };
    }


    // ========================================================
    // ПОЗИЦИИ WB
    // ========================================================

    const positions =
        await getTodayPositions(
            products,
            today
        );


    // ========================================================
    // ЦЕНЫ ПРОДАВЦА
    // ========================================================

    const nmIds =
        products.map(
            product =>
                Number(
                    product.nmId
                )
        );


    const sellerPrices =
        await getCurrentSellerPrices(
            nmIds
        );


    // ========================================================
    // СЕГОДНЯ
    // ========================================================

    await fillTodayPrices(
        products,
        today,
        sellerPrices
    );


    // ========================================================
    // ОСТАТКИ
    // ========================================================

    const stocks =
        await getStocks(
            dateFrom,
            today
        );


    const meta =
        stocks._meta || {};


    // ========================================================
    // ПОСЛЕДНИЕ 3 ДНЯ
    // ========================================================

    const last3 =
        dates.slice(-3);


    // ========================================================
    // РЕКЛАМА
    // ========================================================

    const promotionStats =
        await getPromotionStats(
            last3[0],
            last3[last3.length - 1]
        );


    // ========================================================
    // ПОСЛЕДНИЕ 7 ДНЕЙ
    // ========================================================

    const last7 =
        dates.slice(-7);


    // ========================================================
    // СНАЧАЛА ФИНАЛЬНО ОПРЕДЕЛЯЕМ
    // article КАЖДОГО ТОВАРА
    // ========================================================

    for (
        const product of products
    ) {

        const nmId =
            Number(
                product.nmId
            );


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
    }


    // ========================================================
    // ТЕПЕРЬ ПОЛУЧАЕМ СЕБЕСТОИМОСТЬ
    //
    // ВАЖНО:
    // article уже окончательный.
    // ========================================================

    const moySkladCosts =
        await getMoySkladCosts(
            products
        );


    // ========================================================
    // ФОРМИРУЕМ РЕЗУЛЬТАТ
    // ========================================================

    const result = [];


    for (
        const product of products
    ) {

        const nmId =
            Number(
                product.nmId
            );


        const stock =
            stocks[nmId] || {};


        // ----------------------------------------------------
        // ПРОДАЖИ ЗА 7 ДНЕЙ
        // ----------------------------------------------------

        const sales7 =
            last7.reduce(
                (
                    sum,
                    date
                ) =>
                    sum +
                    Number(
                        product.days[date]
                            ?.sales || 0
                    ),
                0
            );


        const averageSales7 =
            sales7 / 7;


        // ----------------------------------------------------
        // ОСТАТОК
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

        const positionToday =
            positions[nmId] ?? null;


        // ----------------------------------------------------
        // СЕБЕСТОИМОСТЬ
        // ----------------------------------------------------

        const article =
            String(
                product.article || ''
            ).trim();


        const cost =
            article &&
            moySkladCosts[article] != null

                ? moySkladCosts[article]

                : null;


        // ----------------------------------------------------
        // 3 ДНЯ
        // ----------------------------------------------------

        const days =
            last3.map(
                date => {

                    const d =
                        product.days[date] || {};


                    const advertising =
                        promotionStats[nmId]?.[date] || {
                            views: 0,
                            clicks: 0,
                            atbs: 0,
                            cpm: 0,
                            spend: 0
                        };


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
                            ),


                        advertising: {

                            views:
                                Number(
                                    advertising.views || 0
                                ),

                            clicks:
                                Number(
                                    advertising.clicks || 0
                                ),

                            atbs:
                                Number(
                                    advertising.atbs || 0
                                ),

                            cpm:
                                Number(
                                    advertising.cpm || 0
                                ),

                            spend:
                                Number(
                                    advertising.spend || 0
                                )
                        },


                        buyerPriceSource:
                            date === today
                                ? 'current-api'
                                : (
                                    d.buyerPrice == null
                                        ? null
                                        : 'order'
                                ),


                        sellerPriceSource:
                            date === today
                                ? 'current-api'
                                : (
                                    d.sellerPrice == null
                                        ? null
                                        : 'order'
                                ),


                        sppSource:
                            date === today
                                ? 'calculated'
                                : (
                                    d.spp == null
                                        ? null
                                        : 'order'
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


            // ================================================
            // НОВОЕ ПОЛЕ
            // ================================================

            cost,


            days
        });
    }


    return {

        updatedAt:
            new Date().toISOString(),

        period: {

            from:
                dateFrom,

            to:
                today
        },

        products:
            result
    };
}


// ============================================================
// API DASHBOARD
// ============================================================

let dashboardRunning = false;


app.get(
    '/api/dashboard',
    async (
        req,
        res
    ) => {

        if (
            dashboardRunning
        ) {

            return res
                .status(409)
                .json({

                    success:
                        false,

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

                success:
                    true,

                ...data
            });


        } catch (error) {

            console.error(
                'DASHBOARD ERROR:',
                error
            );


            res
                .status(500)
                .json({

                    success:
                        false,

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
// HEALTH CHECK
// ============================================================

app.get(
    '/api/test',
    (
        req,
        res
    ) => {

        res.json({

            success:
                true,

            message:
                'WB Dashboard API работает',

            date:
                new Date().toISOString(),

            moscowToday:
                getMoscowToday()
        });
    }
);
