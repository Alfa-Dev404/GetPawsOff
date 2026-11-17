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

    const SEVERITY_ORDER = ['high', 'med', 'low'];
    const SEVERITY_WORD = { high: 'Serious', med: 'Moderate', low: 'Minor' };

    function severityOf(finding) {
      const category = state.categoryById[finding.categoryId];
      return category && SEVERITY_WORD[category.severity] ? category.severity : 'low';
    }

    function severityCounts(findings) {
      const counts = { high: 0, med: 0, low: 0 };
      for (const finding of findings) counts[severityOf(finding)] += 1;
      return counts;
    }

    function worstSeverity(counts) {
      return SEVERITY_ORDER.find((severity) => counts[severity] > 0) || 'clear';
    }

    // The figure is set large beside the words, so the two read as one sentence.
    function panelHeadline(counts) {
      const total = counts.high + counts.med + counts.low;
      if (!total) return { figure: '', words: 'Nothing risky found' };
      if (counts.high) return { figure: String(counts.high), words: (counts.high === 1 ? 'serious clause' : 'serious clauses') + ' in these terms' };
      return { figure: String(total), words: (total === 1 ? 'clause' : 'clauses') + ' worth a look' };
    }

    // One to three scratch marks: minor, moderate, serious.
    function severityMarks(severity) {
      const marks = document.createElement('span');
      marks.className = 'po-ts-marks';
      marks.setAttribute('aria-hidden', 'true');
      for (let i = SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(severity); i > 0; i -= 1) marks.appendChild(document.createElement('i'));
      return marks;
    }

    function panelHeader(findings) {
      const counts = severityCounts(findings);
      const head = document.createElement('div');
      head.className = 'po-ts-head ' + worstSeverity(counts);
      const said = panelHeadline(counts);
      const count = document.createElement('span');
      count.className = 'po-ts-count';
      count.textContent = said.figure;
      const copy = document.createElement('span');
      copy.className = 'po-ts-head-copy';
      const headline = document.createElement('span');
      headline.className = 'po-ts-headline';
      headline.textContent = said.words;
      const title = document.createElement('span');
      title.className = 'po-ts-title';
      title.textContent = panelTitle(findings.length);
      copy.appendChild(headline);
      copy.appendChild(title);
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
      if (said.figure) head.appendChild(count);
      head.appendChild(copy);
      head.appendChild(actions);
      return head;
    }

    function severityGroup(severity, size) {
      const group = document.createElement('div');
      group.className = 'po-ts-group ' + severity;
      group.appendChild(severityMarks(severity));
      const word = document.createElement('span');
      word.textContent = SEVERITY_WORD[severity];
      const count = document.createElement('span');
      count.className = 'po-ts-group-count';
      count.textContent = String(size);
      group.appendChild(word);
      group.appendChild(count);
      return group;
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
      const severity = severityOf(finding);
      item.className = 'po-ts-item ' + severity;
      const body = document.createElement('span');
      const tag = document.createElement('span');
      tag.className = 'po-ts-vh';
      tag.textContent = SEVERITY_WORD[severity] + ': ';
      body.appendChild(tag);
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
      // Worst first, page order within a severity.
      const counts = severityCounts(findings);
      for (const severity of SEVERITY_ORDER) {
        if (!counts[severity]) continue;
        list.appendChild(severityGroup(severity, counts[severity]));
        for (const finding of findings) if (severityOf(finding) === severity) list.appendChild(findingListItem(finding));
      }
      return list;
    }

    function panelFooter(hasFindings) {
      const foot = document.createElement('div');
      foot.className = 'po-ts-foot';
      const attribution = state.reputationSource && state.reputationSource.attribution;
      const suffix = attribution ? ' ' + attribution : '';
      foot.textContent = (hasFindings ? 'Select a clause to jump to it. ' : '') + 'Read on this device, not legal advice.' + suffix;
      return foot;
    }

    function panelCard(findings, entering) {
      const card = document.createElement('div');
      card.className = entering ? 'po-ts-card po-ts-enter' : 'po-ts-card';
      card.setAttribute('role', 'region');
      card.setAttribute('aria-label', 'GetPawsOff terms scan');
      card.appendChild(panelHeader(findings));
      appendPolicyChange(card);
      appendReputationContext(card);
      card.appendChild(findingsList(findings));
      card.appendChild(panelFooter(findings.length > 0));
      return card;
    }

    function renderPanel(findings) {
      try {
        // Animate only the first appearance, not the re-render after a snapshot update.
        const entering = !state.panelHost;
        options.removePanel();
        const host = document.createElement('div');
        host.className = 'po-ts-root';
        const shadow = host.attachShadow({ mode: 'closed' });
        state.shadowRoot = shadow;
        const style = document.createElement('style');
        style.textContent = options.panelCss;
        shadow.appendChild(style);
        shadow.appendChild(panelCard(findings, entering));
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
