// User/Application: the window that opens when an operator chooses which model
// does a job. A dropdown would hide what these are; the twin runs arithmetic we
// wrote and networks somebody trained, and the difference matters — what each
// one needs, what it can be asked to do, and whether it can run at all.
//
// So the choice is made in a library: one row per model, with what it is for,
// what it needs to be given, and its state. A model that cannot run is still
// shown, with the reason, because an operator looking for the model they were
// told about should find it rather than wonder where it went.
//
// It owns no models and no settings. The server describes both; this draws them
// and answers with the id that was picked.
import {buildElement} from './dom_builder.js';

const FAMILY = {
  kinematic: {label: '규칙 기반', note: '우리가 쓴 운동학. 관측이 드물어도 돌아갑니다.'},
  learned: {label: '학습 모델', note: '외부에서 학습해 전달받은 가중치.'},
  follow: {label: '연동', note: '다른 설정을 따라갑니다.'},
};

export class AiModelLibrary {
  constructor({document = globalThis.document, mount = null, onPick = () => {}} = {}) {
    Object.assign(this, {document, mount, onPick});
    this.root = null; this.isOpen = false; this.request = null;
  }
  el(tag, props = {}, ...children) {return buildElement(this.document, tag, props, ...children);}

  // `job` is what the chosen model will do, `models` what may do it, `chosen`
  // the one in force. `field` and `source` are handed back with the pick so the
  // caller knows which setting was being answered.
  open({source, field, job, jobs = [], models = [], chosen = null, title = 'AI 모델 라이브러리'} = {}) {
    this.close({silent: true});
    this.request = {source, field, job, chosen};
    const description = jobs.find(item => item.id === job);
    const body = this.el('div', {class: 'ai-library-body'});
    for (const model of models) body.append(this.row(model, chosen));
    const panel = this.el('div', {class: 'ai-library glass', role: 'dialog', 'aria-modal': 'true',
      'aria-label': title, id: 'ai-model-library'},
      this.el('header', {},
        this.el('div', {},
          this.el('strong', {text: title}),
          this.el('span', {class: 'ai-library-job', text: description ? `${description.label} — 이 자리에서 쓸 모델` : ''})),
        this.el('button', {type: 'button', class: 'place-close', 'aria-label': '닫기', text: '×',
          onclick: () => this.close()})),
      description?.note ? this.el('p', {class: 'ai-library-note', text: description.note}) : null,
      body);
    this.root = panel; this.isOpen = true;
    (this.mount ?? this.document.body)?.append(panel);
    return panel;
  }

  row(model, chosen) {
    const family = FAMILY[model.family] ?? {label: model.family, note: ''};
    const picked = model.model_id === chosen;
    const usable = model.ready !== false;
    const action = this.el('button', {type: 'button', class: 'ai-library-pick',
      id: `ai-model-${model.model_id}`,
      text: picked ? '사용 중' : usable ? '이 모델 사용' : '사용 불가',
      ...(picked || !usable ? {'aria-disabled': 'true'} : {}),
      onclick: () => {if (usable && !picked) this.pick(model.model_id);}});
    if (picked || !usable) action.disabled = true;
    return this.el('article', {class: `ai-library-card${picked ? ' ai-library-current' : ''}${usable ? '' : ' ai-library-blocked'}`,
      'data-model': model.model_id, 'data-family': model.family},
      this.el('div', {class: 'ai-library-head'},
        this.el('strong', {text: model.label}),
        this.el('span', {class: 'ai-library-family', text: family.label})),
      this.el('div', {class: 'ai-library-tags'},
        this.el('span', {text: model.function || ''}),
        this.el('span', {text: model.application || ''}),
        this.el('span', {text: model.scope || ''})),
      model.note ? this.el('p', {class: 'ai-library-text', text: model.note}) : null,
      model.requires ? this.el('p', {class: 'ai-library-needs', text: `필요한 입력 · ${model.requires}`}) : null,
      usable ? null : this.el('p', {class: 'ai-library-blocked-why', text: model.reason || '지금은 사용할 수 없습니다.'}),
      this.el('div', {class: 'ai-library-actions'}, action));
  }

  pick(modelId) {
    const request = this.request;
    this.close({silent: true});
    if (request) this.onPick({...request, model: modelId});
  }

  close({silent = false} = {}) {
    const wasOpen = this.isOpen;
    this.root?.remove();
    this.root = null; this.isOpen = false;
    if (!silent) this.request = null;
    return wasOpen;
  }
}
