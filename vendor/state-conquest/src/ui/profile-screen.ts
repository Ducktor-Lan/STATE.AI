import { button, clear, el, setText } from './dom';
import { avatarNode } from './avatar';
import {
  DEFAULT_AVATAR_ID,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  PROFILE_AVATARS,
  validateAvatarId,
  validateNickname,
} from './profile-store';
import type { CommanderProfile, ProfileResult } from './profile-store';
import {
  DEFAULT_PLAYER_COLOR_ID,
  normalizePlayerColorId,
  PLAYER_COLOR_OPTIONS,
} from './player-colors';
import type { PlayerColorId } from './player-colors';

export type ProfileScreenMode = 'create' | 'edit';

export interface ProfileScreenOptions {
  mode: ProfileScreenMode;
  profile: CommanderProfile | null;
  /** Shown above the form, e.g. when a stored archive failed validation. */
  notice?: string;
}

export interface ProfileScreenCallbacks {
  onBack?: () => void;
  /** Returns the store result; !ok keeps the screen open with the message. */
  onSave: (
    nickname: string,
    avatarId: string,
    playerColorId?: PlayerColorId
  ) => ProfileResult;
}

/**
 * Commander dossier. A valid nickname + preset avatar is the local "login":
 * no account, no network. The same screen creates the first archive and edits
 * an existing one (the back button only exists in edit mode).
 */
export class ProfileScreen {
  readonly el: HTMLElement;

  private readonly callbacks: ProfileScreenCallbacks;
  private readonly input: HTMLInputElement;
  private readonly errorNode: HTMLElement;
  private readonly previewHost: HTMLElement;
  private readonly previewName: HTMLElement;
  private readonly avatarButtons: HTMLButtonElement[] = [];
  private readonly colorButtons: HTMLButtonElement[] = [];
  private selectedAvatarId: string;
  private selectedColorId: PlayerColorId;

  constructor(options: ProfileScreenOptions, callbacks: ProfileScreenCallbacks) {
    const self = this;
    this.callbacks = callbacks;
    const profile = options.profile;
    this.selectedAvatarId =
      profile && validateAvatarId(profile.avatarId) === null
        ? profile.avatarId
        : DEFAULT_AVATAR_ID;
    this.selectedColorId = normalizePlayerColorId(
      profile ? profile.playerColorId : DEFAULT_PLAYER_COLOR_ID
    );

    const root = el('section', 'screen profile-screen');
    root.setAttribute('aria-labelledby', 'profile-title');

    const header = el('header', 'setup-header');
    if (callbacks.onBack) {
      const back = button('返回', 'back-btn', callbacks.onBack);
      back.setAttribute('aria-label', '返回首页');
      header.appendChild(back);
    }
    const titles = el('div', 'setup-titles');
    const title = el(
      'h1',
      'setup-title',
      options.mode === 'create' ? '创建指挥官档案' : '指挥官档案'
    );
    title.id = 'profile-title';
    const subtitle = el(
      'p',
      'setup-subtitle',
      options.mode === 'create' ? '首次出征 · 请先登记' : '本地档案 · 昵称与头像'
    );
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(titles);

    const body = el('div', 'setup-body');

    if (options.notice) {
      body.appendChild(el('p', 'profile-notice', options.notice));
    }

    const preview = el('div', 'profile-preview');
    this.previewHost = el('div', 'profile-preview-avatar');
    this.previewName = el(
      'p',
      'profile-preview-name',
      profile ? profile.nickname : '未命名指挥官'
    );
    const previewNote = el('p', 'profile-preview-note', '金币与策反等级记录在这份本机档案中');
    preview.appendChild(this.previewHost);
    preview.appendChild(this.previewName);
    preview.appendChild(previewNote);
    body.appendChild(preview);

    body.appendChild(el('span', 'profile-field-label', '头像'));
    const grid = el('div', 'avatar-grid');
    for (let i = 0; i < PROFILE_AVATARS.length; i += 1) {
      const avatar = PROFILE_AVATARS[i];
      const option = el('button', 'avatar-option');
      option.type = 'button';
      option.setAttribute('aria-label', '头像 ' + avatar.name);
      option.setAttribute('aria-pressed', avatar.id === this.selectedAvatarId ? 'true' : 'false');
      option.appendChild(avatarNode(avatar.id, 'avatar-sm'));
      option.appendChild(el('span', 'avatar-option-name', avatar.name));
      option.addEventListener('click', function () {
        self.selectAvatar(avatar.id);
      });
      this.avatarButtons.push(option);
      grid.appendChild(option);
    }
    body.appendChild(grid);

    body.appendChild(el('span', 'profile-field-label', '领地颜色'));
    const colorGrid = el('div', 'player-color-grid');
    for (let i = 0; i < PLAYER_COLOR_OPTIONS.length; i += 1) {
      const option = PLAYER_COLOR_OPTIONS[i];
      const colorButton = el('button', 'player-color-option') as HTMLButtonElement;
      colorButton.type = 'button';
      colorButton.setAttribute('aria-label', '领地颜色 ' + option.name);
      colorButton.setAttribute('data-color', option.id);
      colorButton.setAttribute(
        'aria-pressed',
        option.id === this.selectedColorId ? 'true' : 'false'
      );
      const swatch = el('span', 'player-color-swatch');
      swatch.style.backgroundColor = option.fill;
      swatch.style.borderColor = option.edge;
      colorButton.appendChild(swatch);
      colorButton.appendChild(el('span', 'player-color-name', option.name));
      colorButton.addEventListener('click', function () {
        self.selectColor(option.id);
      });
      this.colorButtons.push(colorButton);
      colorGrid.appendChild(colorButton);
    }
    body.appendChild(colorGrid);

    body.appendChild(el('span', 'profile-field-label', '昵称'));
    const field = el('div', 'profile-name-field');
    this.input = el('input', 'profile-name-input') as HTMLInputElement;
    this.input.type = 'text';
    this.input.maxLength = NICKNAME_MAX_LENGTH;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = '输入昵称（1~12 个字符）';
    this.input.value = profile ? profile.nickname : '';
    this.input.setAttribute('aria-label', '指挥官昵称');
    if (options.mode === 'create') this.input.setAttribute('data-autofocus', '');
    this.input.addEventListener('input', function () {
      self.syncPreviewName();
      if (self.errorNode.textContent) self.showError('');
    });
    field.appendChild(this.input);
    body.appendChild(field);

    this.errorNode = el('p', 'profile-error');
    this.errorNode.setAttribute('role', 'alert');
    body.appendChild(this.errorNode);

    body.appendChild(
      el(
        'p',
        'profile-hint',
        '昵称 ' +
          NICKNAME_MIN_LENGTH +
          '~' +
          NICKNAME_MAX_LENGTH +
          ' 个字符 · 头像可随时更换 · 档案仅保存在本机'
      )
    );

    const footer = el('footer', 'setup-footer setup-footer-compact');
    const save = button(
      options.mode === 'create' ? '建立档案' : '保存档案',
      'btn btn-primary btn-wide',
      function () {
        self.submit();
      }
    );
    save.setAttribute('aria-label', options.mode === 'create' ? '建立档案' : '保存档案');
    footer.appendChild(save);

    root.appendChild(header);
    root.appendChild(body);
    root.appendChild(footer);
    this.el = root;

    this.syncSelection();
    this.syncColorSelection();
    this.syncPreviewName();
  }

  private selectAvatar(avatarId: string): void {
    this.selectedAvatarId = avatarId;
    this.syncSelection();
    if (this.errorNode.textContent) this.showError('');
  }

  private selectColor(colorId: PlayerColorId): void {
    this.selectedColorId = normalizePlayerColorId(colorId);
    this.syncColorSelection();
    if (this.errorNode.textContent) this.showError('');
  }

  private syncSelection(): void {
    for (let i = 0; i < this.avatarButtons.length; i += 1) {
      const node = this.avatarButtons[i];
      const id = PROFILE_AVATARS[i].id;
      const active = id === this.selectedAvatarId;
      if (active) node.classList.add('is-active');
      else node.classList.remove('is-active');
      node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    clear(this.previewHost);
    this.previewHost.appendChild(avatarNode(this.selectedAvatarId, 'avatar-lg'));
  }

  private syncColorSelection(): void {
    for (let i = 0; i < this.colorButtons.length; i += 1) {
      const button = this.colorButtons[i];
      const active = button.getAttribute('data-color') === this.selectedColorId;
      if (active) button.classList.add('is-active');
      else button.classList.remove('is-active');
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private syncPreviewName(): void {
    const trimmed = this.input.value.trim();
    setText(this.previewName, trimmed.length > 0 ? trimmed : '未命名指挥官');
  }

  private showError(message: string): void {
    this.errorNode.textContent = message;
    if (message) this.errorNode.classList.add('is-visible');
    else this.errorNode.classList.remove('is-visible');
  }

  private submit(): void {
    const nameError = validateNickname(this.input.value);
    if (nameError) {
      this.showError(nameError);
      this.input.focus();
      return;
    }
    const avatarError = validateAvatarId(this.selectedAvatarId);
    if (avatarError) {
      this.showError(avatarError);
      return;
    }
    const result = this.callbacks.onSave(
      this.input.value,
      this.selectedAvatarId,
      this.selectedColorId
    );
    if (!result.ok) {
      this.showError(result.message || '档案保存失败，请重试');
      return;
    }
    this.showError('');
  }
}
