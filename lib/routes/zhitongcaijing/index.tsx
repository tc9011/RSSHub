import { load } from 'cheerio';
import pMap from 'p-map';

import CaptchaError from '@/errors/types/captcha';
import type { DataItem, Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import { sha1 } from '@/utils/hash';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/time';

const ids = {
    recommend: {
        url: 'content/recommend',
        title: '推荐',
    },
    hkstock: {
        url: 'content/hkstock',
        title: '港股',
    },
    meigu: {
        url: 'content/meigu',
        title: '美股',
    },
    agu: {
        url: 'content/agu',
        title: '沪深',
    },
    ct: {
        url: 'content/ct',
        title: '创投',
    },
    esg: {
        url: 'content/esg',
        title: 'ESG',
    },
    aqs: {
        url: 'content/aqs',
        title: '券商',
    },
    ajj: {
        url: 'content/ajj',
        title: '基金',
    },
    focus: {
        url: 'focus',
        title: '要闻',
    },
    announcement: {
        url: 'announcement',
        title: '公告',
    },
    research: {
        url: 'research',
        title: '研究',
    },
    shares: {
        url: 'shares',
        title: '新股',
    },
    bazaar: {
        url: 'bazaar',
        title: '市场',
    },
    company: {
        url: 'company',
        title: '公司',
    },
};

const mix = (k: number) => {
    const k1 = Math.imul(k, 0xcc_9e_2d_51);
    return Math.imul((k1 << 15) | (k1 >>> 17), 0x1b_87_35_93);
};

// MurmurHash3 of `host&parm_0&parm_1&width&height`, seeded with parm_1
function generateAlicfw(host: string, parm0: string, parm1: string) {
    const width = (1920 ^ 0x4f_2b_3a_41) >>> 0;
    const height = (1080 ^ 0x4f_2b_3a_41) >>> 0;
    const key = Buffer.from(`${host}&${parm0}&${parm1}&${width}&${height}`);

    let hash = Number(parm1) % 0x1f_74_80;
    const tail = key.length & 3;
    let i = 0;
    for (; i < key.length - tail; i += 4) {
        hash ^= mix(key.readInt32LE(i));
        hash = Math.imul((hash << 13) | (hash >>> 19), 5) + 0xe6_54_6b_64;
    }
    if (tail) {
        hash ^= mix(key[i] | (key[i + 1] << 8) | (key[i + 2] << 16));
    }
    hash ^= key.length;
    hash = Math.imul(hash ^ (hash >>> 16), 0x85_eb_ca_6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2_b2_ae_35);

    return `${(hash ^ (hash >>> 16)) >>> 0}|${parm1}|${width}|${height}`;
}

export const route: Route = {
    path: '/:id?/:category?',
    categories: ['finance'],
    view: ViewType.Articles,
    example: '/zhitongcaijing',
    parameters: { id: '栏目 id，可在对应栏目页 URL 中找到，默认为 recommend，即推荐', category: '分类 id，可在对应栏目子分类页 URL 中找到，默认为全部' },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '推荐',
    maintainers: ['nczitzk'],
    handler,
    description: `| id           | 栏目 |
| ------------ | ---- |
| recommend    | 推荐 |
| hkstock      | 港股 |
| meigu        | 美股 |
| agu          | 沪深 |
| ct           | 创投 |
| esg          | ESG  |
| aqs          | 券商 |
| ajj          | 基金 |
| focus        | 要闻 |
| announcement | 公告 |
| research     | 研究 |
| shares       | 新股 |
| bazaar       | 市场 |
| company      | 公司 |`,
};

async function handler(ctx) {
    const id = ctx.req.param('id') ?? 'recommend';
    const category = ctx.req.param('category') ?? '';

    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20;

    const rootUrl = 'https://www.zhitongcaijing.com';
    const currentUrl = `${rootUrl}/${ids[id].url}.html${category === '' ? '' : `?category_key=${category}`}`;
    const apiUrl = `${rootUrl}/${ids[id].url}.html?data_type=1&page=1${category === '' ? '' : `&category_key=${category}`}`;

    let data = await ofetch(apiUrl);
    if (typeof data === 'string') {
        const $ = load(data);
        const alicfw = generateAlicfw(new URL(rootUrl).host, $('#parm_0').attr('value')!, $('#parm_1').attr('value')!);
        data = await ofetch(apiUrl, {
            headers: {
                cookie: `alicfw=${encodeURIComponent(alicfw)}`,
            },
        });
    }

    if (typeof data === 'string') {
        throw new CaptchaError('Zhitong Caijing returned a browser verification page; article data is unavailable.');
    }
    if (data.status !== 'success') {
        throw new TypeError('Zhitong Caijing did not return a successful article list.');
    }

    const list: Array<DataItem & { link: string; contentId: string }> = data.data.slice(0, limit).map((item) => ({
        title: item.title,
        link: new URL(item.url, rootUrl).href,
        description: item.digest,
        author: item.author_info.author_name,
        pubDate: parseDate((item.create_time ?? item.original_time) * 1000),
        category: [...(item.keywords?.split(',') ?? []), item.category_name ?? item.type_tag],
        contentId: item.original_id,
    }));

    const items = await pMap(
        list,
        ({ contentId, ...item }) =>
            cache.tryGet(item.link, async () => {
                const query = `__mode__=history&access_token=&content_id=${contentId}&language=zh-cn&tradition_chinese=0`;
                const detail = await ofetch(`https://betaapi.zhitongcaijing.com/Article/get?${query}&token=${sha1(query)}`, {
                    responseType: 'json',
                });
                item.description = detail.data.content_detail.content;

                return item;
            }),
        { concurrency: 3 }
    );

    return {
        title: `智通财经 - ${ids[id].title}`,
        link: currentUrl,
        item: items,
    };
}
