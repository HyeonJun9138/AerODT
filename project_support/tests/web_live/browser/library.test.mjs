import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LibraryPanel, describeState, formValues, patchFrom} from '../../../../user_application/web/library_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

const description = {
  schema_version: 1,
  groups: [
    {id: 'live', kind: 'sources', label: '실시간 자료', note: '바깥에서 받아오는 것'},
    {id: 'display', kind: 'sources', label: '지도 표시', note: '지구를 어떻게 그릴지'},
    {id: 'simulation', kind: 'sources', label: '시뮬레이션', note: '이 작업공간에서 만든 것'},
    {id: 'exports', kind: 'exports', label: '데이터 추출', note: '접속한 컴퓨터에 저장됩니다'},
    {id: 'models', kind: 'models', label: '3D 모델', note: '훑어보는 용도'},
  ],
  sources: [
    {id: 'aircraft', group: 'live', label: '항공기', provider: 'OpenSky Network', note: '요청 주기 주의',
     fields: [{name: 'enabled', kind: 'toggle', label: '수집'},
       {name: 'poll_seconds', kind: 'number', label: '수신 주기', unit: '초', min: 30, max: 3600, step: 5},
       {name: 'retention_seconds', kind: 'number', label: '상태 보관', unit: '초', min: 60, max: 3600, step: 10},
       {name: 'follow_view', kind: 'toggle', label: '지도 화면 따라가기'},
       {name: 'bounds', kind: 'bounds', label: '수신 범위', span: {min: .05, max: 25}}]},
    {id: 'satellite', group: 'live', label: '위성', provider: 'CelesTrak GP', note: '저장 자료 사용 중',
     fields: [{name: 'enabled', kind: 'toggle', label: '실시간 요청'},
       {name: 'poll_seconds', kind: 'number', label: '수신 주기', unit: '초', min: 3600, max: 86400, step: 600}]},
    {id: 'uam', group: 'simulation', label: 'UAM', provider: '내부 시뮬레이션', note: '연동 준비 중', fields: []},
    {id: 'clouds', group: 'display', label: '구름 영상', provider: 'NASA EOSDIS GIBS', note: '표시 설정',
     fields: [{name: 'enabled', kind: 'toggle', label: '표시'},
       {name: 'product', kind: 'choice', label: '자료', choices: [{id: 'himawari', label: 'Himawari'}, {id: 'modis', label: 'MODIS'}]},
       {name: 'opacity', kind: 'number', label: '진하기', unit: '0~1', min: .1, max: 1, step: .05}]},
    {id: 'terrain', group: 'display', label: '지형', provider: 'Cesium World Terrain', note: '표시 설정',
     fields: [{name: 'enabled', kind: 'toggle', label: '표시'}]},
  ],
  values: {
    aircraft: {enabled: true, poll_seconds: 45, retention_seconds: 300, follow_view: true,
      bounds: {lamin: 33, lamax: 38.6, lomin: 126, lomax: 130}},
    satellite: {enabled: false, poll_seconds: 7200},
    clouds: {enabled: false, product: 'himawari', opacity: .6},
    uam: {}, terrain: {enabled: true},
  },
  state: [
    {id: 'aircraft', status: 'error', message: '공급자 HTTP 429', updated_at: 1788900000},
    {id: 'satellite', status: 'cached', message: '저장 궤도 기반 계산', updated_at: 1788899000},
    {id: 'uam', status: 'pending', message: '연동 준비 중', updated_at: null},
    {id: 'clouds', status: 'disabled', message: '표시 꺼짐', updated_at: null},
    {id: 'terrain', status: 'ready', message: '공급자 연결됨', updated_at: null},
  ],
};

class FakeElement {
  constructor(tag) {this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.dataset = {}; this.style = {}; this._text = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.parent = null;}
  get textContent() {return this.children.length ? this.children.map(c => c.textContent).join('') + this._text : this._text;}
  set textContent(v) {this.children = []; this._text = String(v);}
  get className() {return this.attributes.class ?? '';}
  set className(v) {this.attributes.class = v;}
  setAttribute(k, v) {this.attributes[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'hidden') this.hidden = true;}
  getAttribute(k) {return this.attributes[k] ?? null;}
  removeAttribute(k) {delete this.attributes[k];}
  append(...nodes) {for (const n of nodes) {if (typeof n === 'string') {this._text += n; continue;} n.parent = this; this.children.push(n);}}
  remove() {if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);}
  *walk() {for (const c of this.children) {yield c; yield* c.walk();}}
  matches(selector) {
    const [tag, rest] = selector.match(/^([a-z]*)(.*)$/).slice(1);
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!rest) return true;
    if (rest.startsWith('#')) return this.attributes.id === rest.slice(1);
    if (rest.startsWith('.')) return (this.attributes.class ?? '').split(/\s+/).includes(rest.slice(1));
    const attribute = rest.match(/^\[([a-z_-]+)=(.+)\]$/);
    return attribute ? this.attributes[attribute[1]] === attribute[2] : false;
  }
  querySelector(s) {for (const n of this.walk()) if (n.matches(s)) return n; return null;}
  querySelectorAll(s) {return [...this.walk()].filter(n => n.matches(s));}
  click() {this.onclick?.({preventDefault() {}});}
}
const fakeDocument = {createElement: tag => new FakeElement(tag)};

const EXPORTS = {schema_version: 1, exports: [
  {id: 'vertiports', label: '버티포트 설계', format: 'json', note: '정의와 생성된 배치',
    filename: 'aerodt-vertiports-20260910.json', summary: '버티포트 18개', available: true},
  {id: 'routes', label: '항로 설계', format: 'json', note: '지점과 구간',
    filename: 'aerodt-routes-20260910.json', summary: '지점 57개 · 구간 26개', available: true},
  {id: 'airspace', label: '공역 (GeoJSON)', format: 'geojson', note: 'GIS 도구에서 열립니다',
    filename: 'aerodt-airspace-20260910.geojson', summary: '공역 자료 없음 (인증 설정 필요)', available: false},
]};

function harness({fail = false, exports = EXPORTS} = {}) {
  const sent = [], notices = [], applied = [], asked = [];
  const api = {
    describe: async () => description,
    exports: async () => {
      asked.push('exports');
      if (exports instanceof Error) throw exports;
      return exports;
    },
    apply: async patch => {
      sent.push(patch);
      if (fail) throw Object.assign(new Error('bad'), {data: {field: 'aircraft.poll_seconds', message: 'aircraft.poll_seconds: 30~3600 사이여야 합니다'}});
      // The server merges the patch into what it holds and answers with all of it.
      const values = structuredClone(description.values);
      for (const [id, fields] of Object.entries(patch.sources)) values[id] = {...values[id], ...fields};
      return {...description, values};
    },
  };
  const panel = new LibraryPanel({api, document: fakeDocument, notify: (s, m) => notices.push([s, m]),
    onDisplay: (id, enabled) => applied.push([id, enabled])});
  const body = new FakeElement('div');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {panel, body, api, sent, notices, applied, asked, settle};
}

test('a source state reads as a state and a reason', () => {
  assert.match(describeState({status: 'ready', message: '외부 자료 수신', updated_at: 1788900000}), /수신/);
  assert.match(describeState({status: 'error', message: '공급자 HTTP 429'}), /공급자 HTTP 429/);
  assert.match(describeState({status: 'paused', message: 'Library 설정으로 수집 중지'}), /중지/);
  assert.equal(describeState(null), '상태 없음');
  assert.equal(describeState({status: 'pending', message: '연동 준비 중'}), '연동 준비 중', 'a message that repeats the state is not said twice');
});

test('the panel shows every source with its provider, live state and editable fields', async () => {
  const {panel, body} = harness();
  panel.render(body);
  await panel.ready;
  const cards = body.querySelectorAll('.library-card');
  assert.equal(cards.length, 5);
  const aircraft = body.querySelector('#library-aircraft');
  assert.match(aircraft.textContent, /항공기/);
  assert.match(aircraft.textContent, /OpenSky Network/);
  assert.match(aircraft.textContent, /공급자 HTTP 429/, 'the live state is on the card, not hidden in a log');
  assert.equal(body.querySelector('[name=aircraft__poll_seconds]').value, '45');
  assert.equal(body.querySelector('[name=aircraft__enabled]').checked, true);
  assert.equal(body.querySelector('[name=aircraft__bounds__lamin]').value, '33');
  assert.equal(body.querySelector('[name=satellite__enabled]').checked, false);
  assert.equal(body.querySelector('[name=satellite__poll_seconds]').value, '7200');
  const uam = body.querySelector('#library-uam');
  assert.match(uam.textContent, /연동 준비 중/);
  assert.equal(uam.querySelectorAll('input').length, 0, 'a source with no settings offers none');
  assert.match(aircraft.textContent, /요청 주기 주의/, 'the provider note is shown where it matters');
});

test('each source is a closed layer that opens on click and closes again', async () => {
  const {panel, body} = harness();
  panel.render(body);
  await panel.ready;
  const head = body.querySelector('#library-aircraft-head');
  const details = body.querySelector('#library-aircraft-body');
  assert.equal(head.tagName, 'BUTTON', 'the whole header is the control, not a stray icon');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(head.getAttribute('aria-controls'), 'library-aircraft-body');
  assert.equal(details.hidden, true, 'a panel of settings starts closed');
  assert.match(head.textContent, /항공기/);
  assert.match(head.textContent, /공급자 HTTP 429/, 'the state is readable without opening the layer');
  assert.match(details.textContent, /요청 주기 주의/, 'the note and the fields live inside');
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);
  const satellite = body.querySelector('#library-satellite-head');
  satellite.click();
  head.click();
  assert.equal(body.querySelector('#library-satellite-body').hidden, false, 'layers open independently');
  assert.equal(body.querySelector('#library-aircraft-body').hidden, false);
  const uam = body.querySelector('#library-uam-head');
  assert.equal(uam.getAttribute('aria-disabled'), 'true', 'a source with nothing to set does not pretend to open');
  uam.click();
  assert.equal(body.querySelector('#library-uam-body').hidden, true);
});

test('an open layer stays open when the panel redraws after applying', async () => {
  const {panel, body, settle} = harness();
  panel.render(body);
  await panel.ready;
  body.querySelector('#library-aircraft-head').click();
  body.querySelector('[name=aircraft__poll_seconds]').value = '120';
  await panel.save();
  await settle();
  assert.equal(body.querySelector('#library-aircraft-head').getAttribute('aria-expanded'), 'true');
  assert.equal(body.querySelector('#library-satellite-body').hidden, true, 'and a closed one stays closed');
});

test('only what changed is sent, and the answer becomes the new baseline', async () => {
  const {panel, body, sent, notices, settle} = harness();
  panel.render(body);
  await panel.ready;
  const values = formValues(body, description);
  assert.equal(values.aircraft.poll_seconds, 45);
  body.querySelector('[name=aircraft__poll_seconds]').value = '120';
  body.querySelector('[name=aircraft__enabled]').checked = false;
  assert.deepEqual(patchFrom(formValues(body, description), description.values),
    {sources: {aircraft: {enabled: false, poll_seconds: 120}}}, 'untouched sources and fields are left alone');
  await panel.save();
  await settle();
  assert.deepEqual(sent, [{sources: {aircraft: {enabled: false, poll_seconds: 120}}}]);
  assert.ok(notices.some(([status]) => status === 'ready'));
  assert.equal(panel.values.aircraft.poll_seconds, 120);
  await panel.save();
  assert.equal(sent.length, 1, 'saving again with nothing changed sends nothing');
});

test('a rejected change names the field, keeps the form and changes no baseline', async () => {
  const {panel, body, settle} = harness({fail: true});
  panel.render(body);
  await panel.ready;
  body.querySelector('[name=aircraft__poll_seconds]').value = '2';
  await panel.save();
  await settle();
  assert.match(body.querySelector('#library-error').textContent, /aircraft.poll_seconds/);
  assert.equal(panel.values.aircraft.poll_seconds, 45, 'the baseline is unchanged');
  assert.equal(body.querySelector('[name=aircraft__poll_seconds]').value, '2', 'and what the operator typed is still there');
});

test('display sources are applied to the map as well as stored, with everything the map needs', async () => {
  const {panel, body, applied, settle} = harness();
  panel.render(body);
  await panel.ready;
  assert.deepEqual(applied, [['clouds', {enabled: false, product: 'himawari', opacity: .6}], ['terrain', {enabled: true}]],
    'the stored display choices are applied when the panel loads, values and all');
  body.querySelector('[name=terrain__enabled]').checked = false;
  await panel.save();
  await settle();
  assert.deepEqual(applied.at(-1), ['terrain', {enabled: false}]);
});

test('a choice is a list of what the server offers, and it is sent as chosen', async () => {
  const {panel, body, sent, applied, settle} = harness();
  panel.render(body);
  await panel.ready;
  const select = body.querySelector('[name=clouds__product]');
  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(select.children.map(option => option.attributes.value), ['himawari', 'modis']);
  assert.equal(select.value, 'himawari');
  select.value = 'modis';
  body.querySelector('[name=clouds__enabled]').checked = true;
  await panel.save();
  await settle();
  assert.deepEqual(sent, [{sources: {clouds: {enabled: true, product: 'modis'}}}], 'the choice travels as an id, not a number');
  assert.deepEqual(applied.at(-1), ['clouds', {enabled: true, product: 'modis', opacity: .6}],
    'the map is handed the whole set, not only what changed');
});

test('a display source can be switched from outside the panel and stays in step', async () => {
  const {panel, body, sent, applied, settle} = harness();
  panel.render(body);
  await panel.ready;
  await panel.setEnabled('clouds', true);
  await settle();
  assert.deepEqual(sent.at(-1), {sources: {clouds: {enabled: true}}}, 'the switch is stored like any other change');
  assert.equal(body.querySelector('[name=clouds__enabled]').checked, true, 'and the panel shows it');
  assert.equal(panel.values.clouds.enabled, true);
  await panel.setEnabled('clouds', true);
  assert.equal(sent.length, 1, 'setting it to what it already is sends nothing');
});

test('the sources are folded into the groups the server named, and a group opens on click', async () => {
  const {panel, body} = harness();
  panel.render(body);
  await panel.ready;
  const groups = body.querySelectorAll('.library-group');
  assert.deepEqual(groups.map(g => g.getAttribute('id')),
    ['library-group-live', 'library-group-display', 'library-group-simulation', 'library-group-exports', 'library-group-models'],
    'in the order the server declared them');
  assert.ok(groups.every(g => g.getAttribute('data-open') === 'false'), 'the panel opens as a short list of folds');
  const live = body.querySelector('#library-group-live-body');
  assert.equal(live.hidden, true);
  assert.equal(live.querySelectorAll('.library-card').length, 2, '항공기 and 위성 live in 실시간 자료');
  assert.equal(body.querySelector('#library-group-display-body').querySelectorAll('.library-card').length, 2);
  assert.equal(body.querySelector('#library-group-simulation-body').querySelectorAll('.library-card').length, 1);
  body.querySelector('#library-group-live-head').click();
  assert.equal(live.hidden, false);
  assert.equal(body.querySelector('#library-group-live-head').getAttribute('aria-expanded'), 'true');
  assert.equal(body.querySelector('#library-group-live').getAttribute('data-open'), 'true');
  assert.equal(body.querySelector('#library-group-display-body').hidden, true, 'groups open independently');
  body.querySelector('#library-group-live-head').click();
  assert.equal(live.hidden, true, 'and close again');
});

test('a closed group says how much it holds, and shows a failing source through the fold', async () => {
  const {panel, body} = harness();
  panel.render(body);
  await panel.ready;
  const stateOf = id => body.querySelector(`#library-group-${id}-head`).querySelector('.library-state');
  // 항공기 is in error in the fixture: the fold must not hide that.
  assert.equal(stateOf('live').getAttribute('data-status'), 'error');
  assert.match(stateOf('live').textContent, /HTTP 429/);
  assert.equal(stateOf('display').textContent, '2개', 'nothing wrong: just how many');
  assert.equal(stateOf('simulation').textContent, '1개');
  // A later state sweep updates the fold as well as the cards inside it.
  description.state = description.state.map(s => (s.id === 'aircraft' ? {...s, status: 'ready', message: '수신 재개'} : s));
  await panel.refreshState();
  assert.equal(stateOf('live').getAttribute('data-status'), 'unknown');
  assert.equal(stateOf('live').textContent, '2개');
  description.state = description.state.map(s => (s.id === 'aircraft' ? {...s, status: 'error', message: '공급자 HTTP 429'} : s));
});

test('the download group asks what is available when it is opened, and each file is a link the asking computer saves', async () => {
  const {panel, body, asked, settle} = harness();
  panel.render(body);
  await panel.ready;
  assert.deepEqual(asked, [], 'nothing is asked for a group nobody opened');
  body.querySelector('#library-group-exports-head').click();
  await settle();
  assert.deepEqual(asked, ['exports'], 'the counts are of what is stored at the moment it is opened');
  const cards = body.querySelectorAll('.library-export');
  assert.deepEqual(cards.map(c => c.querySelector('strong').textContent), ['버티포트 설계', '항로 설계', '공역 (GeoJSON)']);
  assert.equal(body.querySelector('#library-export-routes-head').querySelector('.library-state').textContent, '지점 57개 · 구간 26개');
  // The card opens to what the file holds and the link that fetches it.
  assert.equal(body.querySelector('#library-export-routes-body').hidden, true);
  body.querySelector('#library-export-routes-head').click();
  assert.equal(body.querySelector('#library-export-routes-body').hidden, false);
  const link = body.querySelector('#library-export-routes-link');
  assert.equal(link.tagName, 'A', 'a plain link, so the browser saves it on its own machine');
  assert.equal(link.getAttribute('href'), '/api/library/exports/routes');
  assert.equal(link.getAttribute('download'), 'aerodt-routes-20260910.json');
  assert.match(body.querySelector('#library-export-routes-body').textContent, /aerodt-routes-20260910\.json/);
  // Nothing behind it: said so, and not offered.
  assert.equal(body.querySelector('#library-export-airspace-link'), null);
  assert.match(body.querySelector('#library-export-airspace').textContent, /내려받을 수 없음/);
  assert.match(body.querySelector('#library-export-airspace-head').textContent, /인증 설정 필요/);
  // Opened again, it asks again: something may have been saved meanwhile.
  body.querySelector('#library-group-exports-head').click();
  body.querySelector('#library-group-exports-head').click();
  await settle();
  assert.deepEqual(asked, ['exports', 'exports']);
});

test('a download catalogue that cannot be read says so and leaves the rest of the Library alone', async () => {
  const {panel, body, settle} = harness({exports: new Error('offline')});
  panel.render(body);
  await panel.ready;
  body.querySelector('#library-group-exports-head').click();
  await settle();
  assert.match(body.querySelector('#library-exports').textContent, /확인하지 못했습니다/);
  assert.equal(body.querySelectorAll('.library-export').length, 0);
  assert.ok(body.querySelector('#library-aircraft'), 'the sources are still there');
  assert.ok(body.querySelector('#library-save'), 'and so are the form buttons');
});

test('the rail carries a Library button that opens its own section', () => {
  const rail = html.match(/<nav\b[^>]*\bid="rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const button = rail.match(/<button\b[^>]*\bid="mode-library"[\s\S]*?<\/button>/)?.[0];
  assert.ok(button, 'the rail has a Library button');
  assert.match(button, /<svg[\s\S]*<\/svg>/, 'with an icon like its neighbours');
  assert.match(button, /Library/);
  assert.ok(rail.indexOf('mode-simulation') < rail.indexOf('mode-library'), 'it follows Simulation');
  assert.match(app, /library:\{label:'Library'/, 'and opens a section of its own');
  assert.match(app, /libraryPanel/);
});

test('the UAM comparison picker and checkboxes save only the chosen visibility without resetting the model',async()=>{
  const {panel,body,api,sent,applied}=harness();
  const values={enabled:true,model:'uam_route_mlp_comparison',seconds:60,short_enabled:true,mid_enabled:true,long_enabled:true};
  const source={id:'uam_prediction',group:'live',label:'UAM 예측',fields:[
    {name:'model',kind:'model',job:'uam_prediction',label:'예측 모델'},
    ...['short','mid','long'].map(key=>({name:`${key}_enabled`,kind:'toggle',label:key}))]};
  const answer={schema_version:1,groups:[{id:'live',kind:'sources',label:'예측'}],sources:[source],values:{uam_prediction:values},
    ai_models:{models:[{model_id:'uam_route_mlp_comparison',label:'세 모델 비교',jobs:['uam_prediction'],ready:true}]}};
  api.describe=async()=>structuredClone(answer);
  api.apply=async patch=>{sent.push(patch);Object.assign(values,patch.sources.uam_prediction);return structuredClone(answer);};
  panel.render(body);await panel.ready;
  assert.match(body.querySelector('#library-uam_prediction-model').textContent,/세 모델 비교/);
  body.querySelector('[name=uam_prediction__mid_enabled]').checked=false;await panel.save();
  assert.deepEqual(sent,[{sources:{uam_prediction:{mid_enabled:false}}}]);
  assert.equal(body.querySelector('[name=uam_prediction__short_enabled]').checked,true);
  assert.equal(body.querySelector('[name=uam_prediction__mid_enabled]').checked,false);
  assert.equal(body.querySelector('[name=uam_prediction__model]').value,'uam_route_mlp_comparison');
  assert.equal(applied.at(-1)[1].mid_enabled,false);assert.equal(applied.at(-1)[1].long_enabled,true);
});
