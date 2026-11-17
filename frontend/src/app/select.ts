import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, signal } from '@angular/core';

export interface SelectOption {
  value: string;
  label: string;
}

let nextId = 0;

/** Выпадающий список в стиле приложения (вместо системного select). Клавиатура: стрелки, Home/End, Enter, Esc. */
@Component({
  selector: 'app-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'onOutside($event)', '(focusout)': 'onFocusOut($event)' },
  template: `
    <button type="button" class="trigger" [class.open]="open()" role="combobox" aria-haspopup="listbox"
            [attr.aria-expanded]="open()" [attr.aria-controls]="id" [attr.aria-label]="label()"
            [attr.aria-activedescendant]="open() ? id + '-' + active() : null"
            (click)="toggle()" (keydown)="onKey($event)">
      <span class="text">{{ current()?.label }}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
    </button>
    @if (open()) {
      <ul class="menu" role="listbox" [id]="id" [attr.aria-label]="label()" (mousedown)="$event.preventDefault()">
        @for (o of options(); track o.value; let i = $index) {
          <li role="option" [id]="id + '-' + i" [attr.aria-selected]="o.value === value()"
              [class.active]="i === active()" [class.selected]="o.value === value()"
              (pointerenter)="active.set(i)" (click)="choose(i)">
            <span class="text">{{ o.label }}</span>
            @if (o.value === value()) {
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 6 10.5 11 4.5" /></svg>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host { display: block; position: relative; }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
      padding: 9px 12px; border: 1px solid var(--ctl-border); border-radius: 6px; background: var(--ctl-bg);
      font: inherit; color: var(--ctl-text); text-align: left; cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s; }
    .trigger:hover { border-color: var(--ctl-border-hover); }
    .trigger:focus-visible, .trigger.open { outline: none; border-color: var(--ctl-focus);
      box-shadow: 0 0 0 3px var(--ctl-ring); }
    .trigger svg { flex: none; color: var(--ctl-icon); transition: transform 0.18s; }
    .trigger.open svg { transform: rotate(180deg); }
    .menu { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; right: 0; margin: 0; padding: 5px;
      list-style: none; max-height: 300px; overflow-y: auto; background: var(--menu-bg);
      border: 1px solid var(--menu-border); border-radius: 6px;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1), 0 16px 36px rgba(0, 0, 0, 0.22);
      transform-origin: top; animation: menu-in 0.14s ease-out; }
    @keyframes menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
    @media (prefers-reduced-motion: reduce) { .menu { animation: none; } .trigger svg { transition: none; } }
    li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px;
      border-radius: 4px; font-size: 0.93rem; color: var(--menu-text); cursor: pointer; }
    li.active { background: var(--menu-hover); }
    li.selected { color: var(--menu-selected); font-weight: 700; }
    li.selected.active { background: var(--menu-selected-bg); }
    li svg { flex: none; }
  `,
})
export class Select {
  readonly options = input.required<SelectOption[]>();
  readonly label = input('');
  readonly value = model.required<string>();

  protected readonly id = `app-select-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly active = signal(0);
  protected readonly current = computed(() => this.options().find((o) => o.value === this.value()));

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  protected toggle(): void {
    if (this.open()) this.open.set(false);
    else this.show();
  }

  private show(): void {
    this.active.set(Math.max(0, this.options().findIndex((o) => o.value === this.value())));
    this.open.set(true);
  }

  protected choose(i: number): void {
    const option = this.options()[i];
    if (option) this.value.set(option.value);
    this.open.set(false);
  }

  protected onKey(e: KeyboardEvent): void {
    const last = this.options().length - 1;
    if (!this.open()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.show();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': this.active.update((i) => Math.min(last, i + 1)); break;
      case 'ArrowUp': this.active.update((i) => Math.max(0, i - 1)); break;
      case 'Home': this.active.set(0); break;
      case 'End': this.active.set(last); break;
      case 'Enter':
      case ' ': this.choose(this.active()); break;
      case 'Escape': this.open.set(false); break;
      default: return;
    }
    e.preventDefault();
  }

  protected onOutside(e: Event): void {
    if (this.open() && !this.host.contains(e.target as Node)) this.open.set(false);
  }

  protected onFocusOut(e: FocusEvent): void {
    if (!this.host.contains(e.relatedTarget as Node | null)) this.open.set(false);
  }
}
