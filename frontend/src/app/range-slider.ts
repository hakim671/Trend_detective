import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';

/** Ползунок с двумя ручками: два наложенных друг на друга input[type=range]. */
@Component({
  selector: 'app-range-slider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="values"><span>{{ value()[0] }}{{ suffix() }}</span><span>{{ value()[1] }}{{ suffix() }}</span></div>
    <div class="track">
      <div class="fill" [style.left.%]="pct()[0]" [style.right.%]="100 - pct()[1]"></div>
      <input type="range" [min]="min()" [max]="max()" [step]="step()" [value]="value()[0]"
             [attr.aria-label]="label() + ': min'" (input)="setLow($event)" />
      <input type="range" [min]="min()" [max]="max()" [step]="step()" [value]="value()[1]"
             [attr.aria-label]="label() + ': max'" (input)="setHigh($event)" />
    </div>
  `,
  styles: `
    :host { display: block; }
    .values { display: flex; justify-content: space-between; font-size: 0.84rem; font-weight: 600;
              color: var(--value); font-variant-numeric: tabular-nums; }
    .track { position: relative; height: 22px; }
    .track::before, .fill { content: ''; position: absolute; top: 9px; height: 4px; border-radius: 2px; }
    .track::before { left: 0; right: 0; background: var(--track); }
    .fill { background: var(--accent); }
    input { position: absolute; inset: 0; width: 100%; margin: 0; background: none; pointer-events: none;
            -webkit-appearance: none; appearance: none; }
    input::-webkit-slider-runnable-track { background: none; height: 22px; }
    input::-moz-range-track { background: none; }
    input::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 18px; height: 18px;
            margin-top: 2px; border-radius: 50%; background: var(--thumb); border: 2px solid var(--accent);
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); cursor: pointer; }
    input::-moz-range-thumb { pointer-events: auto; width: 14px; height: 14px; border-radius: 50%;
            background: var(--thumb); border: 2px solid var(--accent); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
            cursor: pointer; }
    input:focus-visible { outline: none; }
    input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--ctl-ring); }
    input:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px var(--ctl-ring); }
  `,
})
export class RangeSlider {
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input(1);
  /** Минимальное расстояние между ручками: ближе друг к другу их сдвинуть нельзя. */
  readonly minGap = input(0);
  /** Ручку пытались сдвинуть ближе допустимого, и она упёрлась в ограничение. */
  readonly blocked = output<void>();
  readonly suffix = input('');
  readonly label = input('');
  readonly value = model.required<[number, number]>();

  protected readonly pct = computed(() => {
    const span = this.max() - this.min() || 1;
    return this.value().map((v) => ((v - this.min()) / span) * 100);
  });

  protected setLow(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = Math.max(this.min(), Math.min(+el.value, this.value()[1] - this.minGap()));
    if (v !== +el.value) this.blocked.emit();
    el.value = String(v);
    this.value.set([v, this.value()[1]]);
  }

  protected setHigh(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = Math.min(this.max(), Math.max(+el.value, this.value()[0] + this.minGap()));
    if (v !== +el.value) this.blocked.emit();
    el.value = String(v);
    this.value.set([this.value()[0], v]);
  }
}
