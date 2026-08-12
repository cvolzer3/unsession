/**
 * Speaker portal island (`/{event}/portal`).
 *
 * The portal is built out of real form POSTs so it works without JavaScript;
 * this file only adds the conveniences the prototype implies: picking a file
 * submits its upload straight away, the headshot shows a local preview before
 * saving, and "Jump to profile" scrolls instead of reloading.
 */
import { toast } from './ui.js';

/* Task file requests: choosing a file uploads it immediately. */
document.querySelectorAll('form[data-upload] input[type=file]').forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.files || !input.files.length) return;
    const form = input.closest('form');
    const label = input.closest('label');
    if (label) {
      // The input lives inside the label — swap only the text nodes, or the
      // file control (and the file with it) would be ripped out of the form.
      [...label.childNodes].forEach((node) => {
        if (node !== input) node.remove();
      });
      label.prepend('Uploading…');
    }
    toast('Uploading ' + input.files[0].name + '…');
    form.submit();
  });
});

/* Headshot: local preview + filename, saved with the rest of the profile. */
const headshot = document.querySelector('[data-headshot]');
if (headshot) {
  headshot.addEventListener('change', () => {
    const file = headshot.files && headshot.files[0];
    if (!file) return;
    const name = document.getElementById('headshot-name');
    if (name) name.textContent = file.name + ' — save the profile to keep it';
    const preview = document.getElementById('headshot-preview');
    if (preview) {
      const url = URL.createObjectURL(file);
      preview.style.background = `url(${url}) center/cover`;
      preview.textContent = '';
    }
  });
}

/* "Jump to profile" on profile-completion tasks. */
document.addEventListener('click', (e) => {
  const jump = e.target.closest('[data-jump-profile]');
  if (!jump) return;
  e.preventDefault();
  const target = document.getElementById('profile');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const nameInput = document.querySelector('input[name=name]');
  if (nameInput) setTimeout(() => nameInput.focus(), 350);
});
