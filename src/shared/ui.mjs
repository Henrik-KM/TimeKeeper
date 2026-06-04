export function ensureToastRegion() {
  let region = document.querySelector('.app-toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'app-toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

export function showToast(message, options = {}) {
  const region = ensureToastRegion();
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  let timeoutId = null;
  const close = () => {
    if (timeoutId) clearTimeout(timeoutId);
    toast.remove();
  };
  if (options.actionLabel && typeof options.onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn secondary';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      options.onAction();
      close();
    });
    toast.appendChild(action);
  }
  region.appendChild(toast);
  timeoutId = setTimeout(close, options.timeoutMs || 8000);
  return close;
}

let modalIdCounter = 0;

function getFocusableElements(container) {
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function trapFocus(event, panel) {
  if (event.key !== 'Tab') return;
  const focusable = getFocusableElements(panel);
  if (!focusable.length) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function requestConfirm({
  title = 'Confirm',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const titleId = `modal-title-${++modalIdCounter}`;
    const descriptionId = `modal-description-${modalIdCounter}`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.role = 'dialog';
    panel.tabIndex = -1;
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('aria-describedby', descriptionId);
    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('h3');
    heading.className = 'modal-title';
    heading.id = titleId;
    heading.textContent = title;
    header.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const paragraph = document.createElement('p');
    paragraph.id = descriptionId;
    paragraph.textContent = message;
    body.appendChild(paragraph);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn secondary';
    cancel.textContent = cancelLabel;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = danger ? 'btn danger' : 'btn primary';
    confirm.textContent = confirmLabel;
    let finished = false;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      trapFocus(event, panel);
    };
    const finish = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(false);
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKeyDown);
    confirm.focus();
  });
}

export function openFormDialog({
  title,
  fields,
  submitLabel = 'Save',
  cancelLabel = 'Cancel'
}) {
  return new Promise((resolve) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const titleId = `modal-title-${++modalIdCounter}`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('form');
    panel.className = 'modal-panel';
    panel.role = 'dialog';
    panel.tabIndex = -1;
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('h3');
    heading.className = 'modal-title';
    heading.id = titleId;
    heading.textContent = title;
    header.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const controls = {};
    const syncers = [];
    const renderField = (field) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'modal-field';
      const label = document.createElement('label');
      label.textContent = field.label;
      wrapper.appendChild(label);
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        (field.options || []).forEach((option) => {
          const opt = document.createElement('option');
          opt.value = option.value;
          opt.textContent = option.label;
          input.appendChild(opt);
        });
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = field.rows || 3;
      } else {
        input = document.createElement('input');
        input.type = field.type || 'text';
        if (field.step !== undefined) input.step = String(field.step);
        if (field.min !== undefined) input.min = String(field.min);
      }
      input.value = field.value ?? '';
      input.required = !!field.required;
      if (field.placeholder && 'placeholder' in input) {
        input.placeholder = field.placeholder;
      }
      label.htmlFor = field.name;
      input.id = field.name;
      wrapper.appendChild(input);
      body.appendChild(wrapper);
      controls[field.name] = input;
      if (typeof field.visibleWhen === 'function') {
        syncers.push(() => {
          wrapper.style.display = field.visibleWhen(controls) ? '' : 'none';
        });
      }
      input.addEventListener('change', () => {
        syncers.forEach((sync) => sync());
      });
      input.addEventListener('input', () => {
        syncers.forEach((sync) => sync());
      });
    };
    fields.forEach((field) => renderField(field));
    syncers.forEach((sync) => sync());
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn secondary';
    cancel.textContent = cancelLabel;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn primary';
    submit.textContent = submitLabel;
    let finished = false;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
        return;
      }
      trapFocus(event, panel);
    };
    const close = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
      resolve(value);
    };
    cancel.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      Object.keys(controls).forEach((name) => {
        values[name] = controls[name].value;
      });
      close(values);
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);
    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKeyDown);
    const first = Object.values(controls)[0];
    if (first) first.focus();
  });
}
