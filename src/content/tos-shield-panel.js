(function (root) {
  'use strict';

  function create(options) {
    const document = options.document;
    const state = options.state;

    function panelTitle(findingCount) {
      if (!findingCount) return 'GetPawsOff: Scan complete';
      const noun = findingCount === 1 ? 'clause' : 'clauses';
      return 'GetPawsOff · ' + findingCount + ' ' + noun + ' flagged';
    }

    function panelHeader(findingCount) {
      const head = document.createElement('div');
      head.className = 'po-ts-head';
      const title = document.createElement('span');
      title.className = 'po-ts-title';
      title.textContent = panelTitle(findingCount);
      const actions = document.createElement('span');
      actions.className = 'po-ts-actions';
      const closeBtn = document.createElement('button');
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', () => {
        options.clearHighlights();
        options.removePanel();
      });
      actions.appendChild(closeBtn);
      head.appendChild(title);
      head.appendChild(actions);
      return head;
    }

    function appendPolicyChange(card) {
      if (!state.policyChange) return;
      const change = document.createElement('div');
      change.className = 'po-ts-change';
      change.textContent = state.policyChange.summary;
      card.appendChild(change);
    }

    function appendReputationContext(card) {
      if (!state.reputation) return;
      const presentation = options.gradePresentation(state.reputation.grade);
      const context = document.createElement('div');
      context.className = 'po-ts-context';
      const grade = document.createElement('span');
      grade.className = 'po-ts-grade ' + presentation.tone;
      grade.textContent = presentation.label;
      grade.setAttribute('aria-label', 'ToS;DR grade ' + presentation.label);
      const copy = document.createElement('div');
      copy.className = 'po-ts-context-copy';
      const title = document.createElement('div');
      title.className = 'po-ts-context-title';
      title.textContent = state.reputation.name;
      const note = document.createElement('div');
      note.className = 'po-ts-context-note';
      note.textContent = 'ToS;DR · ' + presentation.summary + '. Separate from local findings.';
      copy.appendChild(title);
      copy.appendChild(note);
      context.appendChild(grade);
      context.appendChild(copy);
      card.appendChild(context);
    }

    function findingEvidenceText(finding) {
      const count = Number.isInteger(finding.phraseCount) ? finding.phraseCount : 0;
      if (!count) return options.findingEvidenceLabel(finding) + ' · context only';
      const noun = count === 1 ? ' highlight' : ' highlights';
      return options.findingEvidenceLabel(finding) + ' · ' + count + ' exact' + noun;
    }

    function findingListItem(finding) {
      const category = state.categoryById[finding.categoryId] || { label: finding.categoryId, severity: 'low' };
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'po-ts-item';
      const dot = document.createElement('span');
      dot.className = 'po-ts-dot ' + category.severity;
      item.appendChild(dot);
      const body = document.createElement('span');
      const categoryElement = document.createElement('span');
      categoryElement.className = 'po-ts-cat';
      categoryElement.textContent = category.label + (finding.level === 'aggravated' ? ' (severe)' : '');
      const snippet = document.createElement('span');
      snippet.className = 'po-ts-snip';
      snippet.textContent = options.truncate(finding.text, 160);
      const evidence = document.createElement('span');
      evidence.className = 'po-ts-evidence';
      evidence.textContent = findingEvidenceText(finding);
      body.appendChild(categoryElement);
      body.appendChild(snippet);
      body.appendChild(evidence);
      item.appendChild(body);
      item.addEventListener('click', () => options.scrollToFinding(finding));
      return item;
    }

    function findingsList(findings) {
      const list = document.createElement('div');
      list.className = 'po-ts-list';
      if (!findings.length) {
        const empty = document.createElement('div');
        empty.className = 'po-ts-empty';
        empty.textContent = 'No risky clauses found.';
        list.appendChild(empty);
      }
      for (const finding of findings) list.appendChild(findingListItem(finding));
      return list;
    }

    function panelFooter() {
      const foot = document.createElement('div');
      foot.className = 'po-ts-foot';
      const attribution = state.reputationSource && state.reputationSource.attribution;
      const suffix = attribution ? ' ' + attribution : '';
      foot.textContent = 'Informational only, not legal advice. Clauses analysed locally.' + suffix;
      return foot;
    }

    function panelCard(findings) {
      const card = document.createElement('div');
      card.className = 'po-ts-card';
      card.appendChild(panelHeader(findings.length));
      appendPolicyChange(card);
      appendReputationContext(card);
      card.appendChild(findingsList(findings));
      card.appendChild(panelFooter());
      return card;
    }

    function renderPanel(findings) {
      try {
        options.removePanel();
        const host = document.createElement('div');
        host.className = 'po-ts-root';
        const shadow = host.attachShadow({ mode: 'closed' });
        state.shadowRoot = shadow;
        const style = document.createElement('style');
        style.textContent = options.panelCss;
        shadow.appendChild(style);
        shadow.appendChild(panelCard(findings));
        (document.documentElement || document.body).appendChild(host);
        state.panelHost = host;
      } catch (error) {
        options.logStatus('panel_error', { message: error && error.message });
      }
    }

    return { renderPanel, panelTitle };
  }

  root.PawsOffTosPanel = { create };
}(typeof window !== 'undefined' ? window : globalThis));
