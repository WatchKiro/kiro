import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTextField, keyAction, ownsArrow } from '@/features/remote/keys';

describe('keyAction', () => {
  it('reads arrows as moves', () => {
    assert.deepEqual(keyAction({ key: 'ArrowUp' }), { kind: 'move', direction: 'up' });
    assert.deepEqual(keyAction({ key: 'ArrowLeft' }), { kind: 'move', direction: 'left' });
  });

  it('reads Enter and Space as activate, Escape and Backspace as back', () => {
    assert.deepEqual(keyAction({ key: 'Enter' }), { kind: 'activate' });
    assert.deepEqual(keyAction({ key: ' ' }), { kind: 'activate' });
    assert.deepEqual(keyAction({ key: 'Escape' }), { kind: 'back' });
    assert.deepEqual(keyAction({ key: 'Backspace' }), { kind: 'back' });
    assert.deepEqual(keyAction({ key: 'GoBack' }), { kind: 'back' });
    assert.deepEqual(keyAction({ key: 'BrowserBack' }), { kind: 'back' });
  });

  it('reads ? as help', () => {
    assert.deepEqual(keyAction({ key: '?' }), { kind: 'help' });
  });

  it('reads the Menu key and Shift F10 as menu', () => {
    assert.deepEqual(keyAction({ key: 'ContextMenu' }), { kind: 'menu' });
    assert.deepEqual(keyAction({ key: 'F10', shiftKey: true }), { kind: 'menu' });
    assert.equal(keyAction({ key: 'F10' }), null);
    assert.equal(keyAction({ key: 'F10', shiftKey: true, ctrlKey: true }), null);
  });

  it('leaves shortcuts with modifiers alone', () => {
    assert.equal(keyAction({ key: 'ArrowLeft', metaKey: true }), null);
    assert.equal(keyAction({ key: 'Backspace', ctrlKey: true }), null);
    assert.equal(keyAction({ key: 'Enter', altKey: true }), null);
    assert.equal(keyAction({ key: 'k', metaKey: true }), null);
  });

  it('reads media keys, with or without modifiers', () => {
    assert.deepEqual(keyAction({ key: 'MediaPlayPause' }), { kind: 'media', command: 'playPause' });
    assert.deepEqual(keyAction({ key: 'MediaTrackNext', metaKey: true }), {
      kind: 'media',
      command: 'next',
    });
    assert.deepEqual(keyAction({ key: 'MediaTrackPrevious' }), {
      kind: 'media',
      command: 'previous',
    });
  });

  it('reads TV remote buttons that come only as key codes', () => {
    assert.deepEqual(keyAction({ key: 'Unidentified', keyCode: 461 }), { kind: 'back' });
    assert.deepEqual(keyAction({ key: 'XF86Back', keyCode: 10009 }), { kind: 'back' });
    assert.deepEqual(keyAction({ key: 'Unidentified', keyCode: 417 }), {
      kind: 'media',
      command: 'fastForward',
    });
  });

  it('ignores other keys', () => {
    assert.equal(keyAction({ key: 'a', keyCode: 65 }), null);
    assert.equal(keyAction({ key: 'Tab', keyCode: 9 }), null);
    assert.equal(keyAction({ key: 'Shift', keyCode: 16 }), null);
  });
});

describe('isTextField', () => {
  it('is true for fields that take text', () => {
    assert.equal(isTextField({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(isTextField({ tagName: 'input', type: 'url' }), true);
    assert.equal(isTextField({ tagName: 'INPUT' }), true);
    assert.equal(isTextField({ tagName: 'TEXTAREA' }), true);
    assert.equal(isTextField({ tagName: 'DIV', isContentEditable: true }), true);
  });

  it('is false for everything else', () => {
    assert.equal(isTextField({ tagName: 'INPUT', type: 'range' }), false);
    assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(isTextField({ tagName: 'BUTTON' }), false);
    assert.equal(isTextField({ tagName: 'SELECT' }), false);
    assert.equal(isTextField(null), false);
  });
});

describe('ownsArrow', () => {
  it('keeps Left and Right in text fields, and lets Up and Down leave', () => {
    const search = {
      tagName: 'INPUT',
      type: 'search',
      selectionStart: 2,
      selectionEnd: 2,
      value: 'dune',
    };
    assert.equal(ownsArrow(search, 'left'), true);
    assert.equal(ownsArrow(search, 'right'), true);
    assert.equal(ownsArrow(search, 'up'), false);
    assert.equal(ownsArrow(search, 'down'), false);
  });

  it('leaves a text field past either end of its text, unless the key is held', () => {
    const at = (caret: number, end = caret) => ({
      tagName: 'INPUT',
      type: 'text',
      selectionStart: caret,
      selectionEnd: end,
      value: 'dune',
    });
    assert.equal(ownsArrow(at(0), 'left'), false);
    assert.equal(ownsArrow(at(0), 'right'), true);
    assert.equal(ownsArrow(at(4), 'right'), false);
    assert.equal(ownsArrow(at(4), 'left'), true);
    assert.equal(ownsArrow(at(0), 'left', true), true);
    // A selection collapses first.
    assert.equal(ownsArrow(at(0, 4), 'right'), true);
    // An empty field leaves either way.
    assert.equal(
      ownsArrow({ tagName: 'INPUT', selectionStart: 0, selectionEnd: 0, value: '' }, 'right'),
      false,
    );
    // Fields without a caret (email, number) keep their arrows.
    assert.equal(
      ownsArrow({ tagName: 'INPUT', type: 'email', selectionStart: null }, 'left'),
      true,
    );
  });

  it('keeps every arrow in a text area', () => {
    assert.equal(ownsArrow({ tagName: 'TEXTAREA' }, 'down'), true);
  });

  it('lets sliders take Left and Right', () => {
    const slider = { tagName: 'INPUT', type: 'range' };
    assert.equal(ownsArrow(slider, 'right'), true);
    assert.equal(ownsArrow(slider, 'up'), false);
  });

  it('navigates from buttons, links and menus', () => {
    assert.equal(ownsArrow({ tagName: 'BUTTON' }, 'left'), false);
    assert.equal(ownsArrow({ tagName: 'SELECT' }, 'down'), false);
    assert.equal(ownsArrow(null, 'down'), false);
  });
});
