#!/usr/bin/env node
// Тянет вакансии с opendata.trudvsem.ru (госуслуга «Работа России»)
// и пишет vacancies.json в формате, который читает index.html.
// API публичный, без авторизации. Доки: https://opendata.trudvsem.ru/cms/contents/api

import { writeFile } from 'node:fs/promises';

const CITIES = [
  { name: 'Москва',          region: '7700000000000' },
  { name: 'Санкт-Петербург', region: '7800000000000' },
  // Trudvsem фильтрует по регионам, не городам. Берём всю Свердловскую обл,
  // потом отсеиваем по адресу — оставляем только Екатеринбург.
  { name: 'Екатеринбург',    region: '6600000000000', cityFilter: /екатеринбург/i },
];

// Тематические запросы — без них в выдачу лезет много промышленных позиций,
// которые приложению неинтересны. Текст ищется по job-name и описанию.
// Порядок важен: первые запросы получают приоритет, последние подрезаются
// при превышении MAX_PER_CITY. Удалёнку и стажёрку ставим раньше «курьеров»,
// иначе их в выдаче будет 0.
const QUERIES = [
  'удаленно',
  'стажер',
  'курьер',
  'кассир',
  'продавец',
  'оператор',
  'консультант',
  'официант',
  'администратор',
  'грузчик',
  'упаковщик',
];

const PER_QUERY = 30;
const MAX_PER_CITY = 60;

async function fetchPage(region, text) {
  const params = new URLSearchParams({
    limit: String(PER_QUERY),
    offset: '0',
    text,
  });
  const url = `https://opendata.trudvsem.ru/api/v1/vacancies/region/${region}?${params}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`trudvsem ${r.status} for ${url}`);
  const json = await r.json();
  return json.results?.vacancies?.map(w => w.vacancy).filter(Boolean) || [];
}

function formatSalary(v) {
  const min = v.salary_min;
  const max = v.salary_max;
  const cur = (v.currency || 'руб.').replace(/[«»]/g, '');
  const unit = `${cur}/мес.`;
  const fmt = n => Number(n).toLocaleString('ru-RU').replace(/,/g, ' ');
  if (min && max && min !== max) return `${fmt(min)} — ${fmt(max)} ${unit}`;
  if (min && max && min === max) return `${fmt(min)} ${unit}`;
  if (min) return `от ${fmt(min)} ${unit}`;
  if (max) return `до ${fmt(max)} ${unit}`;
  if (v.salary && v.salary !== '-') return v.salary;
  return 'з/п не указана';
}

function shortLoc(rawAddress, cityName) {
  if (!rawAddress) return `г. ${cityName}`;
  // Берём первые два сегмента (город + улица), отрезаем «дом/корпус/офис».
  const parts = rawAddress.split(',').map(s => s.trim()).filter(Boolean);
  const head = parts.slice(0, 2).join(', ');
  return head.length > 50 ? head.slice(0, 47) + '…' : head || `г. ${cityName}`;
}

function classify(v) {
  const sched = (v.schedule || '').toLowerCase();
  const expYears = Number(v.requirement?.experience ?? 99);
  const text = `${v['job-name'] || ''} ${v.duty || ''} ${v.requirements || ''}`.toLowerCase();

  const remote = /удал[её]н|дистанц/.test(sched) || /удал[её]н|дистанц/.test(text);
  const part = /непол|гибк|сменн/.test(sched);
  const perm = !part && /полн/.test(sched);
  const noexp = expYears <= 1;
  const students = noexp || /студент|молод[её]ж/.test(text);

  return { remote, part, perm: perm && !remote ? perm : perm, noexp, students };
}

function mapItem(v, cityName) {
  const flags = classify(v);
  const loc = flags.remote
    ? 'Удаленно'
    : shortLoc(v.addresses?.address?.[0]?.location, cityName);
  return {
    id: v.id,
    city: cityName,
    title: v['job-name'] || '—',
    emp: v.company?.name?.replace(/^(ООО|ИП|АО|ПАО|ЗАО)\s+/i, m => m.trim() + ' ') || '—',
    salary: formatSalary(v),
    loc,
    tags: flags.students ? ['Студентам'] : [],
    part: !!flags.part,
    perm: !!flags.perm,
    remote: !!flags.remote,
    noexp: !!flags.noexp,
    students: !!flags.students,
    url: v.vac_url,
  };
}

async function syncCity(city) {
  const byId = new Map();
  for (const q of QUERIES) {
    try {
      const items = await fetchPage(city.region, q);
      for (const v of items) {
        if (!v.vac_url) continue;
        if (byId.has(v.id)) continue;
        // Фильтр по городу для регионов, охватывающих несколько городов.
        if (city.cityFilter) {
          const addr = v.addresses?.address?.[0]?.location || '';
          if (!city.cityFilter.test(addr)) continue;
        }
        byId.set(v.id, mapItem(v, city.name));
      }
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`[${city.name}] query "${q}" failed:`, e.message);
    }
  }
  const list = [...byId.values()].slice(0, MAX_PER_CITY);
  console.log(`[${city.name}] ${list.length} vacancies`);
  return list;
}

async function main() {
  const all = [];
  for (const city of CITIES) {
    const list = await syncCity(city);
    all.push(...list);
  }
  if (all.length === 0) {
    throw new Error('No vacancies fetched — aborting to avoid wiping vacancies.json');
  }
  const payload = {
    updatedAt: process.env.SYNC_TIMESTAMP || new Date().toISOString(),
    source: 'trudvsem.ru',
    vacancies: all,
  };
  await writeFile(new URL('../vacancies.json', import.meta.url), JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${all.length} vacancies total`);
}

main().catch(e => { console.error(e); process.exit(1); });
