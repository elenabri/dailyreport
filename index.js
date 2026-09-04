require('dotenv').config();

const express = require('express');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');

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

const WB_TOKEN = process.env.WB_TOKEN;

if (!WB_TOKEN) {

    throw new Error(
        'Не задан WB_TOKEN. Добавь WB_TOKEN в Environment Variables Vercel.'
    );

}


// ============================================================
// МОЙСКЛАД
// ============================================================

const MS_TOKEN = process.env.MS_TOKEN;

if (!MS_TOKEN) {

    throw new Error(
        'Не задан MS_TOKEN. Добавь MS_TOKEN в Environment Variables Vercel.'
    );

}


const api = axios.create({

    baseURL:
        'https://api.moysklad.ru/api/remap/1.2',

    headers: {

        Authorization:
            `Bearer ${MS_TOKEN}`,

        Accept:
            'application/json;charset=utf-8'

    }

});


app.use(express.json());


// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(resolve, ms)
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

        x[p.type] =
            p.value;

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


        await sleep(
            wait
        );

    }

}


// ============================================================
// WB GET С RETRY
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

                        retryAfter =
                            20;

                    }


                    await sleep(
                        retryAfter *
                        1000
                    );


                    continue;

                }


                throw error;

            }


            try {

                return JSON.parse(
                    text
                );

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
                waitSeconds *
                1000
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
                    JSON.stringify(
                        body
                    ),

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

        return JSON.parse(
            text
        );

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
                Date.now() +
                1500;


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

                retryAfter =
                    20;

            }


            console.log(
                `429. Ждём ${retryAfter} сек.`
            );


            analyticsNextRequestAt =
                Date.now() +
                retryAfter *
                1000;


            await sleep(
                retryAfter *
                1000
            );

        }

    }

}


// ============================================================
// РЕКЛАМА — FULLSTATS
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


    // --------------------------------------------------------
    // Получаем кампании
    // --------------------------------------------------------

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
        3 *
        24 *
        60 *
        60 *
        1000;


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


    // --------------------------------------------------------
    // FULLSTATS максимум 50 кампаний
    // --------------------------------------------------------

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


        console.log('');
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

            console.log(
                'FULLSTATS вернул не массив:',
                stats
            );

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

                                views:
                                    0,

                                clicks:
                                    0,

                                atbs:
                                    0,

                                spend:
                                    0

                            };

                        }


                        const target =
                            result[nmId][date];


                        target.views +=
                            Number(
                                nm?.views ||
                                0
                            );


                        target.clicks +=
                            Number(
                                nm?.clicks ||
                                0
                            );


                        target.atbs +=
                            Number(
                                nm?.atbs ||
                                0
                            );


                        target.spend +=
                            Number(
                                nm?.sum ||
                                0
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


    // --------------------------------------------------------
    // CPM
    // --------------------------------------------------------

    for (
        const nmId of
        Object.keys(result)
    ) {

        for (
            const date of
            Object.keys(
                result[nmId]
            )
        ) {

            const item =
                result[nmId][date];


            item.spend =
                Number(
                    item.spend.toFixed(
                        2
                    )
                );


            item.cpm =
                item.views > 0
                    ? Number(
                        (
                            item.spend /
                            item.views *
                            1000
                        ).toFixed(
                            2
                        )
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
            JSON.parse(
                text
            );

    } catch {

        throw new Error(
            `WB Seller API вернул не JSON:\n${text.slice(0, 1000)}`
        );

    }


    const goods =
        data?.data?.listGoods || [];


    const ourIds =
        new Set(
            nmIds.map(
                Number
            )
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
// ТЕКУЩАЯ ЦЕНА ПОКУПАТЕЛЯ
// ============================================================

async function getCurrentBuyerPrice(
    nmId
) {

    const url =
        'https://card.wb.ru/cards/v4/detail' +
        '?appType=1' +
        '&curr=rub' +
        '&dest=-1257786' +
        '&spp=30' +
        `&nm=${nmId}`;


    console.log('');
    console.log(
        `Получаем текущую цену покупателя через curl: ${nmId}`
    );


    try {

        const {
            stdout,
            stderr
        } = await execFileAsync(

            'curl',

            [
                '--silent',
                '--show-error',
                '--location',
                '--compressed',

                '--header',
                'Accept: application/json',

                '--header',
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',

                '--header',
                'Referer: https://www.wildberries.ru/',

                '--header',
                'Origin: https://www.wildberries.ru/',

                url

            ],

            {

                maxBuffer:
                    10 *
                    1024 *
                    1024

            }

        );


        if (!stdout) {

            throw new Error(
                stderr ||
                'curl не вернул данные'
            );

        }


        let data;


        try {

            data =
                JSON.parse(
                    stdout
                );

        } catch {

            throw new Error(
                `card.wb.ru вернул не JSON: ${stdout.slice(0, 500)}`
            );

        }


        const product =
            data?.products?.find(
                p =>
                    Number(p.id) ===
                    Number(nmId)
            );


        if (!product) {

            throw new Error(
                `Товар ${nmId} не найден в card.wb.ru`
            );

        }


        const priceKopecks =
            product?.sizes?.[0]?.price?.product;


        if (
            priceKopecks == null
        ) {

            throw new Error(
                `price.product отсутствует у ${nmId}`
            );

        }


        return Number(
            priceKopecks
        ) / 100;

    } catch (error) {

        console.error(
            `buyerPrice ${nmId} ERROR:`,
            error.message
        );

        throw error;

    }

}


// ============================================================
// ЦЕНЫ И СПП СЕГОДНЯ
// ============================================================

async function fillTodayPrices(
    products,
    today,
    sellerPrices
) {

    for (
        const product of products
    ) {

        const nmId =
            Number(
                product.nmId
            );


        const todayData =
            product.days[today];


        if (!todayData) {

            continue;

        }


        const sellerPrice =
            sellerPrices[nmId];


        if (
            sellerPrice != null &&
            Number.isFinite(
                Number(
                    sellerPrice
                )
            )
        ) {

            todayData.sellerPrice =
                Number(
                    sellerPrice
                );

        } else {

            todayData.sellerPrice =
                null;

        }


        try {

            todayData.buyerPrice =
                await getCurrentBuyerPrice(
                    nmId
                );

        } catch {

            todayData.buyerPrice =
                null;

        }


        if (
            Number(
                todayData.sellerPrice
            ) > 0 &&
            Number(
                todayData.buyerPrice
            ) > 0
        ) {

            const seller =
                Number(
                    todayData.sellerPrice
                );


            const buyer =
                Number(
                    todayData.buyerPrice
                );


            const spp =
                (
                    (
                        seller -
                        buyer
                    ) /
                    seller
                ) *
                100;


            todayData.spp =
                Math.round(
                    spp
                );

        } else {

            todayData.spp =
                null;

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
        await wbGet(
            url
        );


    const dates =
        getDates(
            dateFrom,
            dateTo
        );


    const products = {};


    for (
        const row of rows
    ) {

        const nmId =
            Number(
                row.nmId
            );


        if (
            !Number.isFinite(nmId) ||
            nmId <= 0
        ) {

            continue;

        }


        const date =
            String(
                row.date || ''
            ).slice(
                0,
                10
            );


        if (
            !dates.includes(
                date
            )
        ) {

            continue;

        }


        if (
            !products[nmId]
        ) {

            products[nmId] = {

                nmId,

                article:
                    String(
                        row.supplierArticle ||
                        row.vendorCode ||
                        ''
                    ).trim(),

                name:
                    '',

                days:
                    {}

            };

        }


        if (
            !products[nmId].days[date]
        ) {

            products[nmId].days[date] = {

                sales:
                    0,

                buyerPrice:
                    null,

                spp:
                    null,

                sellerPrice:
                    null

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
        Object.values(
            products
        );


    for (
        const product of result
    ) {

        for (
            const date of dates
        ) {

            if (
                !product.days[date]
            ) {

                product.days[date] = {

                    sales:
                        0,

                    buyerPrice:
                        null,

                    spp:
                        null,

                    sellerPrice:
                        null

                };

            }

        }


        product.orders30 =
            dates.reduce(
                (
                    sum,
                    date
                ) =>
                    sum +
                    Number(
                        product.days[date]
                            ?.sales ||
                        0
                    ),
                0
            );

    }


    return {

        products:
            result,

        dates:
            dates

    };

}


// ============================================================
// СРЕДНИЕ ПОЗИЦИИ
// ============================================================

async function getTodayPositions(
    products,
    today
) {

    const nmIds =
        products
            .map(
                product =>
                    Number(
                        product.nmId
                    )
            )
            .filter(
                nmId =>
                    Number.isFinite(
                        nmId
                    ) &&
                    nmId > 0
            );


    if (
        !nmIds.length
    ) {

        return {};

    }


    if (
        nmIds.length > 50
    ) {

        throw new Error(
            `Товаров ${nmIds.length}. Один запрос WB поддерживает максимум 50 nmId.`
        );

    }


    const body = {

        currentPeriod: {

            start:
                today,

            end:
                today

        },

        nmIds,

        positionCluster:
            'all',

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

        limit:
            50,

        offset:
            0

    };


    const data =
        await wbPostRetry(

            'https://seller-analytics-api.wildberries.ru/api/v2/search-report/table/details',

            body

        );


    const wbProducts =
        data?.data?.products || [];


    const positions = {};


    for (
        const item of wbProducts
    ) {

        const nmId =
            Number(
                item.nmId
            );


        const position =
            item?.avgPosition?.current;


        positions[nmId] =
            position == null
                ? null
                : Number(
                    position
                );

    }


    return positions;

}


// ============================================================
// СОЗДАНИЕ ОТЧЁТА ОСТАТКОВ
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

                    start:
                        dateFrom,

                    end:
                        dateTo

                },

                stockType:
                    'wb',

                skipDeletedNm:
                    false

            }

        }

    );


    return id;

}


// ============================================================
// ЖДЁМ ОТЧЁТ ОСТАТКОВ
// ============================================================

async function waitStockReport(
    id
) {

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


        await sleep(
            2000
        );

    }


    throw new Error(
        'Отчёт остатков не сформировался'
    );

}


// ============================================================
// СКАЧИВАЕМ ОСТАТКИ
// ============================================================

async function downloadStockReport(
    id
) {

    const response =
        await fetch(

            'https://seller-analytics-api.wildberries.ru' +
            `/api/v2/nm-report/downloads/file/${id}`,

            {

                headers: {

                    Authorization:
                        WB_TOKEN

                },

                signal:
                    AbortSignal.timeout(
                        60000
                    )

            }

        );


    if (
        !response.ok
    ) {

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

function parseCSV(
    buffer
) {

    let text =
        buffer
            .toString('utf8')
            .replace(
                /^\uFEFF/,
                ''
            );


    const lines =
        text
            .split(
                /\r?\n/
            )
            .filter(
                x =>
                    x.trim()
            );


    if (
        !lines.length
    ) {

        return [];

    }


    function parseLine(
        line
    ) {

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


            if (
                c === '"'
            ) {

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

                result.push(
                    value
                );

                value =
                    '';

                continue;

            }


            value += c;

        }


        result.push(
            value
        );


        return result;

    }


    const headers =
        parseLine(
            lines[0]
        );


    return lines
        .slice(1)
        .map(
            line => {

                const values =
                    parseLine(
                        line
                    );


                const row = {};


                headers.forEach(
                    (
                        h,
                        i
                    ) => {

                        row[h] =
                            values[i] ??
                            '';

                    }
                );


                return row;

            }
        );

}


// ============================================================
// СОБИРАЕМ ОСТАТКИ
// ============================================================

function buildStocks(
    rows
) {

    const stocks = {};

    const meta = {};


    for (
        const row of rows
    ) {

        const nmId =
            Number(

                String(

                    row.NmID ||
                    row.nmID ||
                    row.nmId ||
                    ''

                )
                    .replace(
                        /\s/g,
                        ''
                    )

            );


        if (
            !Number.isFinite(
                nmId
            ) ||
            nmId <= 0
        ) {

            continue;

        }


        if (
            !stocks[nmId]
        ) {

            stocks[nmId] =
                {};

        }


        if (
            !meta[nmId]
        ) {

            meta[nmId] =
                {};

        }


        if (
            row.Name
        ) {

            meta[nmId].name =
                row.Name;

        }


        if (
            row.VendorCode
        ) {

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
                        row[key] ??
                        0
                    )
                        .replace(
                            /\s/g,
                            ''
                        )
                        .replace(
                            ',',
                            '.'
                        )

                );


            stocks[nmId][date] =
                Number.isFinite(
                    value
                )
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


    const isZip =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;


    if (
        isZip
    ) {

        console.log(
            'Остатки: получен ZIP'
        );


        const zip =
            new AdmZip(
                buffer
            );


        const entry =
            zip
                .getEntries()
                .find(
                    x =>
                        x.entryName
                            .toLowerCase()
                            .endsWith('.csv')
                );


        if (
            !entry
        ) {

            throw new Error(
                'CSV внутри ZIP не найден'
            );

        }


        buffer =
            entry.getData();

    }


    const rows =
        parseCSV(
            buffer
        );


    return buildStocks(
        rows
    );

}


// ============================================================
// СЕБЕСТОИМОСТЬ / ЦЕНА ПОСЛЕДНЕЙ ОТГРУЗКИ РВБ
//
// ВАЖНО:
//
// Это НЕ salePrices.
//
// Для каждого товара:
//
// 1. Берём article из WB.
// 2. Ищем товар МойСклад по code.
// 3. Ищем последнюю отгрузку ООО "РВБ".
// 4. Получаем позиции этой отгрузки.
// 5. Берём position.price.
// 6. Делим на 100.
//
// Результат:
//
// {
//     "4/kon/1-2": 123,
//     "4/kon/35-3": 456
// }
//
// Одна величина на товар.
// ============================================================

async function getMoySkladCosts(
    products
) {

    const result = {};


    const RWB_AGENT_ID =
        'dc169d6f-ed15-11ef-0a80-1a4e002e43ed';


    const RWB_HREF =
        `https://api.moysklad.ru/api/remap/1.2/entity/counterparty/${RWB_AGENT_ID}`;


    // --------------------------------------------------------
    // Берём коды из уже готовой таблицы WB.
    //
    // WB supplierArticle = МойСклад code
    // --------------------------------------------------------

    const uniqueCodes =
        [
            ...new Set(

                products

                    .map(
                        product =>
                            String(
                                product.article ||
                                ''
                            ).trim()
                    )

                    .filter(
                        Boolean
                    )

            )
        ];


    console.log('');
    console.log(
        '========================================'
    );
    console.log(
        `МОЙСКЛАД: ${uniqueCodes.length} товаров`
    );
    console.log(
        '========================================'
    );


    // --------------------------------------------------------
    // Для каждого товара
    // --------------------------------------------------------

    for (
        const code of uniqueCodes
    ) {

        try {

            console.log(
                `МойСклад: ищу товар по code = ${code}`
            );


            // ------------------------------------------------
            // 1. ТОВАР ПО CODE
            // ------------------------------------------------

            const productResponse =
                await api.get(
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


            const msProducts =
                productResponse
                    .data
                    .rows ||
                [];


            if (
                !msProducts.length
            ) {

                console.log(
                    `МойСклад: товар не найден: ${code}`
                );


                result[code] =
                    null;


                continue;

            }


            const product =
                msProducts[0];


            const PRODUCT_HREF =
                product.meta?.href ||
                `https://api.moysklad.ru/api/remap/1.2/entity/product/${product.id}`;


            console.log(
                `МойСклад: товар найден: ${code} → ${product.name || ''}`
            );


            // ------------------------------------------------
            // 2. ПОСЛЕДНЯЯ ОТГРУЗКА РВБ
            // ------------------------------------------------

            const demandResponse =
                await api.get(
                    '/entity/demand',
                    {

                        params: {

                            filter:
                                `agent=${RWB_HREF};assortment=${PRODUCT_HREF}`,

                            order:
                                'moment,desc',

                            limit:
                                1

                        }

                    }
                );


            const demands =
                demandResponse
                    .data
                    .rows ||
                [];


            if (
                !demands.length
            ) {

                console.log(
                    `МойСклад: отгрузка РВБ не найдена: ${code}`
                );


                result[code] =
                    null;


                continue;

            }


            const demand =
                demands[0];


            console.log(
                `МойСклад: последняя отгрузка ${code} → ${
                    demand.name ||
                    demand.id
                }`
            );


            // ------------------------------------------------
            // 3. ПОЛУЧАЕМ ПОЗИЦИИ ОТГРУЗКИ
            // ------------------------------------------------

            const demandResponseFull =
                await api.get(
                    `/entity/demand/${demand.id}`,
                    {

                        params: {

                            expand:
                                'positions,positions.assortment'

                        }

                    }
                );


            const positions =
                demandResponseFull
                    .data
                    .positions?.rows ||
                demandResponseFull
                    .data
                    .positions ||
                [];


            // ------------------------------------------------
            // 4. ИЩЕМ НАШ ТОВАР В ПОЗИЦИЯХ
            // ------------------------------------------------

            const position =
                positions.find(
                    pos => {

                        const assortment =
                            pos.assortment;


                        return (
                            assortment &&
                            (
                                assortment.id ===
                                    product.id ||

                                assortment.meta?.href ===
                                    PRODUCT_HREF
                            )
                        );

                    }
                );


            if (
                !position
            ) {

                console.log(
                    `МойСклад: позиция товара не найдена в отгрузке: ${code}`
                );


                result[code] =
                    null;


                continue;

            }


            // ------------------------------------------------
            // 5. ЦЕНА ИЗ ПОЗИЦИИ
            // ------------------------------------------------

            const cost =
                position.price != null
                    ? Number(
                        position.price
                    ) / 100
                    : null;


            if (
                cost !== null &&
                Number.isFinite(
                    cost
                )
            ) {

                result[code] =
                    cost;


                console.log(
                    `МойСклад: ${code} → себестоимость = ${cost} ₽`
                );

            } else {

                result[code] =
                    null;


                console.log(
                    `МойСклад: ${code} → price отсутствует`
                );

            }

        } catch (error) {

            console.error(
                `МойСклад: ошибка для ${code}:`,
                error.response?.data ||
                error.message
            );


            result[code] =
                null;

        }

    }


    console.log('');
    console.log(
        'МойСклад: итоговые значения:'
    );


    console.log(
        JSON.stringify(
            result,
            null,
            2
        )
    );


    return result;

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
    // ПОЗИЦИИ
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
        stocks._meta ||
        {};


    // ========================================================
    // ВАЖНО:
    // article уже пришёл из WB supplierArticle.
    //
    // Если его нет — тогда берём VendorCode из остатков.
    // Но существующий WB article НЕ перезаписываем.
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
            !product.article &&
            meta[nmId]?.article
        ) {

            product.article =
                meta[nmId].article;

        }

    }


    // ========================================================
    // СЕБЕСТОИМОСТЬ МОЙСКЛАД
    //
    // ПОСЛЕДНИМ ЭТАПОМ ПЕРЕД ФОРМИРОВАНИЕМ RESULT.
    // ========================================================

    const moySkladCosts =
        await getMoySkladCosts(
            products
        );


    // ========================================================
    // ПОСЛЕДНИЕ 3 ДНЯ
    // ========================================================

    const last3 =
        dates.slice(
            -3
        );


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
        dates.slice(
            -7
        );


    const result = [];


    // ========================================================
    // ТОВАРЫ
    // ========================================================

    for (
        const product of products
    ) {

        const nmId =
            Number(
                product.nmId
            );


        const stock =
            stocks[nmId] ||
            {};


        // ----------------------------------------------------
        // ПРОДАЖИ 7 ДНЕЙ
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
                            ?.sales ||
                        0
                    ),

                0

            );


        const averageSales7 =
            sales7 /
            7;


        // ----------------------------------------------------
        // ОСТАТОК
        // ----------------------------------------------------

        const stockToday =
            Number(
                stock[today] ||
                0
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
            positions[nmId] ??
            null;


        // ----------------------------------------------------
        // СЕБЕСТОИМОСТЬ
        //
        // ОДНА ВЕЛИЧИНА НА ТОВАР.
        // ----------------------------------------------------

        const article =
            String(
                product.article ||
                ''
            ).trim();


        const cost =
            article &&
            moySkladCosts[article] != null

                ? moySkladCosts[article]

                : null;


        // ----------------------------------------------------
        // ПОСЛЕДНИЕ 3 ДНЯ
        // ----------------------------------------------------

        const days =
            last3.map(
                date => {

                    const d =
                        product.days[date] ||
                        {};


                    const advertising =
                        promotionStats[nmId]?.[date] ||
                        {

                            views:
                                0,

                            clicks:
                                0,

                            atbs:
                                0,

                            cpm:
                                0,

                            spend:
                                0

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
                                d.sales ||
                                0
                            ),


                        advertising: {

                            views:
                                Number(
                                    advertising.views ||
                                    0
                                ),


                            clicks:
                                Number(
                                    advertising.clicks ||
                                    0
                                ),


                            atbs:
                                Number(
                                    advertising.atbs ||
                                    0
                                ),


                            cpm:
                                Number(
                                    advertising.cpm ||
                                    0
                                ),


                            spend:
                                Number(
                                    advertising.spend ||
                                    0
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


        // ----------------------------------------------------
        // ГОТОВАЯ СТРОКА ТОВАРА
        // ----------------------------------------------------

        result.push({

            nmId,

            article:
                product.article ||
                '',

            name:
                product.name ||
                '',


            todayOrders:
                Number(
                    product.days[today]
                        ?.sales ||
                    0
                ),


            orders30:
                Number(
                    product.orders30 ||
                    0
                ),


            stockToday,


            averageSales7,


            daysLeft,


            positionToday,


            // ================================================
            // СЕБЕСТОИМОСТЬ
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

let dashboardRunning =
    false;


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


// ============================================================
// EXPORT
// ============================================================

module.exports =
    app;
