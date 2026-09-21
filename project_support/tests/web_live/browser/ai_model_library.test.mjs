import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {AiModelLibrary} from '../../../../user_application/web/ai_model_library.js';
import {LibraryPanel, formValues} from '../../../../user_application/web/library_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

const MODELS = [
  {model_id: 'constant_velocity_v1', label: '등속 외삽', family: 'kinematic', function: '궤적 예측',
   application: '기체', scope: '실시간', note: '관측된 속도가 그대로 이어진다고 봅니다.',
   requires: '관측 두 개 이상. 간격 제한 없음', jobs: ['estimation', 'prediction'], ready: true, reason: ''},
  {model_id: 'coordinated_turn_v1', label: '선회 보정 외삽', family: 'kinematic', function: '궤적 예측',
   application: '기체', scope: '실시간', note: '선회율을 재어 그 선회를 이어 갑니다.',
   requires: '관측 두 개 이상. 간격 제한 없음', jobs: ['estimation', 'prediction'], ready: true, reason: ''},
  {model_id: 'gru_direct_v1_1', label: 'GRU 직접예측 v1.1', family: 'learned', function: '궤적 예측',
   application: '기체', scope: '단기 (15초)', note: '최근 3초로 앞 15초를 한 번에 예측합니다.',
   requires: '5 Hz로 16점(3초) 연속 이력', jobs: ['prediction'], ready: false,
   reason: '정규화 값이 없어 예측을 실행하지 않습니다.'},
];
const JOBS = [{id: 'estimation', label: '상태 추정', note: '관측 사이를 메웁니다.'},
  {id: 'prediction', label: '예상 경로', note: '앞으로 갈 길을 그립니다.'}];

const description = {
  schema_version: 1,
  groups: [{id: 'ai_models', section: 'live', kind: 'sources', label: 'AI 모델 · 추정과 예측', note: '둘은 다른 일입니다.'}],
  sources: [
    {id: 'state_estimation', label: '상태 추정 · 자료 정합', provider: '등속 외삽', group: 'ai_models', note: '',
     fields: [{name: 'enabled', kind: 'toggle', label: '상태 추정'},
       {name: 'model', kind: 'model', label: '추정 모델', job: 'estimation'}]},
    {id: 'trajectory_prediction', label: '예상 경로', provider: '추정 모델과 동일', group: 'ai_models', note: '',
     fields: [{name: 'enabled', kind: 'toggle', label: '예상 경로 표시'},
       {name: 'model', kind: 'model', label: '예측 모델', job: 'prediction'},
       {name: 'seconds', kind: 'number', label: '예상 구간', unit: '초', min: 5, max: 120, step: 5}]},
  ],
  values: {state_estimation: {enabled: true, model: 'constant_velocity_v1'},
    trajectory_prediction: {enabled: true, model: 'same_as_estimation', seconds: 15}},
  limits: {},
  ai_models: {jobs: JOBS, models: MODELS, same_as_estimation: 'same_as_estimation'},
  state: [],
};

function harness() {
  const sent = [], picks = [];
  const api = {describe: async () => description, apply: async patch => {sent.push(patch); return description;}};
  const mount = new FakeElement('body');
  const library = new AiModelLibrary({document: fakeDocument, mount, onPick: request => {picks.push(request); panel.chooseModel(request);}});
  const panel = new LibraryPanel({api, section: 'live', document: fakeDocument, aiLibrary: library});
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
  return {panel, body, library, mount, sent, picks, settle};
}

test('choosing a model opens a library window, not a list of names', async () => {
  const {panel, body, library, mount, settle} = harness();
  panel.render(body);
  await panel.ready;
  await settle();
  body.querySelector('#library-group-ai_models-head').click();
  body.querySelector('#library-state_estimation-head').click();
  const button = body.querySelector('#library-state_estimation-model');
  assert.equal(button.tagName, 'BUTTON', 'a button, not a select');
  assert.equal(body.querySelectorAll('select').length, 0, 'no dropdown for a model');
  assert.match(button.textContent, /등속 외삽/, 'it names the model in force');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  button.click();
  const window = mount.querySelector('#ai-model-library');
  assert.ok(window, 'the library window opened');
  assert.equal(window.getAttribute('role'), 'dialog');
  assert.match(window.textContent, /AI 모델 라이브러리/);
  assert.match(window.textContent, /상태 추정/, 'it says which job is being answered');
  assert.equal(library.isOpen, true);
});

test('the window shows what each model is for, which is in use, and which cannot run', () => {
  const picks = [];
  const mount = new FakeElement('body');
  const library = new AiModelLibrary({document: fakeDocument, mount, onPick: request => picks.push(request)});
  library.open({source: 'trajectory_prediction', field: 'model', job: 'prediction', jobs: JOBS,
    models: MODELS.filter(model => model.jobs.includes('prediction')), chosen: 'constant_velocity_v1'});
  const cards = mount.querySelectorAll('.ai-library-card');
  assert.deepEqual(cards.map(card => card.getAttribute('data-model')),
    ['constant_velocity_v1', 'coordinated_turn_v1', 'gru_direct_v1_1']);
  const gru = cards.find(card => card.getAttribute('data-model') === 'gru_direct_v1_1');
  // The columns of the architecture's own model library.
  assert.deepEqual(gru.querySelector('.ai-library-tags').children.map(tag => tag.textContent),
    ['궤적 예측', '기체', '단기 (15초)']);
  assert.match(gru.querySelector('.ai-library-family').textContent, /학습 모델/, 'trained elsewhere, and it says so');
  assert.match(gru.querySelector('.ai-library-needs').textContent, /5 Hz로 16점/, 'what it must be given');
  assert.match(gru.querySelector('.ai-library-blocked-why').textContent, /정규화 값이 없어/);
  assert.match(gru.attributes.class, /ai-library-blocked/);
  assert.equal(gru.querySelector('.ai-library-pick').disabled, true, 'a model that cannot run cannot be chosen');
  const current = cards.find(card => card.getAttribute('data-model') === 'constant_velocity_v1');
  assert.match(current.attributes.class, /ai-library-current/);
  assert.equal(current.querySelector('.ai-library-pick').textContent, '사용 중');
  assert.equal(current.querySelector('.ai-library-pick').disabled, true);
  // Choosing one answers with the setting it was opened for and closes.
  cards.find(card => card.getAttribute('data-model') === 'coordinated_turn_v1').querySelector('.ai-library-pick').click();
  assert.deepEqual(picks, [{source: 'trajectory_prediction', field: 'model', job: 'prediction',
    chosen: 'constant_velocity_v1', model: 'coordinated_turn_v1'}]);
  assert.equal(library.isOpen, false);
  assert.equal(mount.querySelectorAll('#ai-model-library').length, 0);
  // A blocked model answers nothing at all.
  library.open({source: 'trajectory_prediction', field: 'model', job: 'prediction', jobs: JOBS, models: MODELS, chosen: null});
  mount.querySelector('.ai-library-blocked').querySelector('.ai-library-pick').click();
  assert.equal(picks.length, 1);
  library.close();
  assert.equal(library.isOpen, false);
});

test('the picked model is held in the form and saved with everything else', async () => {
  const {panel, body, mount, sent, picks, settle} = harness();
  panel.render(body);
  await panel.ready;
  await settle();
  body.querySelector('#library-group-ai_models-head').click();
  body.querySelector('#library-trajectory_prediction-head').click();
  const button = body.querySelector('#library-trajectory_prediction-model');
  assert.match(button.textContent, /추정 모델과 동일/, 'the prediction follows the estimator to start with');
  button.click();
  const offered = mount.querySelectorAll('.ai-library-card').map(card => card.getAttribute('data-model'));
  assert.deepEqual(offered, ['same_as_estimation', 'constant_velocity_v1', 'coordinated_turn_v1', 'gru_direct_v1_1'],
    'the follow entry is offered first for a prediction');
  mount.querySelector('[data-model=coordinated_turn_v1]').querySelector('.ai-library-pick').click();
  assert.equal(picks.length, 1);
  assert.match(button.textContent, /선회 보정 외삽/, 'the button follows the choice');
  const held = body.querySelector('[name=trajectory_prediction__model]');
  assert.equal(held.getAttribute('type'), 'hidden');
  assert.equal(held.value, 'coordinated_turn_v1');
  assert.equal(formValues(body, description).trajectory_prediction.model, 'coordinated_turn_v1',
    'the form reads it back like any other field');
  await panel.save();
  await settle();
  assert.deepEqual(sent, [{sources: {trajectory_prediction: {model: 'coordinated_turn_v1'}}}],
    'only what changed is sent');
});

test('the estimator is offered only models that can estimate', async () => {
  const {panel, body, mount, settle} = harness();
  panel.render(body);
  await panel.ready;
  await settle();
  body.querySelector('#library-group-ai_models-head').click();
  body.querySelector('#library-state_estimation-head').click();
  body.querySelector('#library-state_estimation-model').click();
  const offered = mount.querySelectorAll('.ai-library-card').map(card => card.getAttribute('data-model'));
  assert.deepEqual(offered, ['constant_velocity_v1', 'coordinated_turn_v1']);
  assert.ok(!offered.includes('gru_direct_v1_1'), 'a network that only predicts is never offered as the estimator');
  assert.ok(!offered.includes('same_as_estimation'), 'and the estimator cannot follow itself');
});

test('the page opens the window for whichever panel asked, and the styles exist', () => {
  assert.match(app, /createPanel\(AiModelLibrary,\{document,mount:document\.body/);
  assert.match(app, /onPick:request=>\{if\(!livePanel\.chooseModel\(request\)\)libraryPanel\.chooseModel\(request\);\}/);
  assert.match(app, /aiLibrary:aiModelLibrary/);
  assert.match(css, /\.ai-library\{/);
  assert.match(css, /\.ai-library-card\[data-family=learned\] \.ai-library-family\{/);
  assert.match(css, /\.library-model\{/);
});
