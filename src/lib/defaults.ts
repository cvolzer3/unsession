/**
 * Defaults stamped onto every new event. Taxonomy options + colors and the
 * email copy are lifted from the prototype (`Event Setup.dc.html` state,
 * `Submissions.dc.html` decision modal, `Speakers.dc.html` reminder,
 * `Evaluation.dc.html` reviewer reminder) with the DevConf specifics swapped
 * for `{{variables}}`.
 */

export const DEFAULT_TAXONOMIES: {
  name: string;
  hasColor: boolean;
  hasDuration: boolean;
  options: { name: string; color?: string; duration?: number }[];
}[] = [
  {
    name: 'Track',
    hasColor: true,
    hasDuration: false,
    options: [
      { name: 'AI & ML', color: '#7048e8' },
      { name: 'Web Platform', color: '#1c7ed6' },
      { name: 'Infrastructure', color: '#0ca678' },
      { name: 'Security', color: '#e03131' },
      { name: 'Developer Experience', color: '#e8590c' },
    ],
  },
  {
    name: 'Format',
    hasColor: false,
    hasDuration: true,
    options: [
      { name: 'Talk', duration: 30 },
      { name: 'Deep Dive', duration: 45 },
      { name: 'Workshop', duration: 90 },
      { name: 'Lightning', duration: 10 },
      { name: 'Panel', duration: 45 },
    ],
  },
  {
    name: 'Level',
    hasColor: false,
    hasDuration: false,
    options: [{ name: 'Intro' }, { name: 'Intermediate' }, { name: 'Advanced' }],
  },
];

/** Only the Main Stage — organizers add the rest on Event Setup. */
export const DEFAULT_ROOMS = [{ name: 'Main Stage', capacity: null as number | null, priority: 1 }];

export type EmailTemplateSeed = { key: string; name: string; subject: string; body: string };

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSeed[] = [
  {
    key: 'accept',
    name: 'Accept v1',
    subject: 'Your session is in — {{session_title}} at {{event_name}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      'Great news — “{{session_title}}” has been accepted for {{event_name}} ({{event_dates}}, {{event_venue}}).\n\n' +
      'Please confirm your participation within 7 days:\n{{confirmation_link}}\n\n' +
      'Once confirmed, you’ll get a short onboarding checklist in your speaker portal.\n\n' +
      '— The {{event_name}} program team',
  },
  {
    key: 'decline',
    name: 'Decline v1',
    subject: 'Your {{event_name}} submission — {{session_title}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      'Thank you for submitting “{{session_title}}”. We had far more strong proposals than slots this year, and we won’t be able to include it.\n\n' +
      '{{individual_feedback}}\n\n' +
      'We’d genuinely love to see you submit again next year.\n\n' +
      '— The {{event_name}} program team',
  },
  {
    key: 'waitlist',
    name: 'Waitlist v1',
    subject: 'Your {{event_name}} submission — {{session_title}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      '“{{session_title}}” is on our waitlist for {{event_name}}. Slots open up every year as schedules shift — we’ll notify you the moment one does.\n\n' +
      'No action needed from you right now.\n\n' +
      '— The {{event_name}} program team',
  },
  {
    key: 'reminder',
    name: 'Evaluation reminder',
    subject: 'Reminder: {{remaining}} evaluations due {{deadline}}',
    body:
      'Hi {{first_name}},\n\n' +
      'A quick nudge from the {{event_name}} program team: you have {{remaining}} evaluations left in your queue, due {{deadline}}.\n\n' +
      'Open your queue: {{evaluate_link}}\n\n' +
      'Thanks for the time you’re putting in,\n{{organizer_name}}',
  },
  {
    key: 'task_nag',
    name: 'Task reminder',
    subject: 'Reminder: “{{task_name}}” is due {{due_date}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      'A quick reminder that “{{task_name}}” for {{event_name}} is due {{due_date}} — {{days_left}} to go.\n\n' +
      'Everything you need is in your speaker portal:\n{{portal_link}}\n\n' +
      'Already done? Reminders stop automatically once a task is complete, so you can ignore this.\n\n' +
      '— The {{event_name}} program team',
  },
  {
    key: 'schedule_notice',
    name: 'Schedule notice',
    subject: 'Your slot at {{event_name}} — {{session_title}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      '“{{session_title}}” is scheduled for {{session_time}} in {{session_room}}.\n\n' +
      'The calendar invite is attached, and your portal always shows the current slot:\n{{portal_link}}\n\n' +
      'If that time does not work, reply to this email and we’ll sort it out.\n\n' +
      '— The {{event_name}} program team',
  },
  {
    key: 'confirm_submission',
    name: 'Submission received',
    subject: 'We’ve got your {{event_name}} submission — {{session_title}}',
    body:
      'Hi {{speaker_name}},\n\n' +
      'Thanks for submitting “{{session_title}}” to {{event_name}}. It’s in the review queue.\n\n' +
      'You can review or edit your submission any time before the deadline from your speaker portal:\n{{portal_link}}\n\n' +
      'We’ll email you as soon as decisions go out.\n\n' +
      '— The {{event_name}} program team',
  },
];

/** IANA zones offered on the create-event / setup selects. */
export const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Prague',
  'Europe/Warsaw',
  'Europe/Stockholm',
  'Europe/Oslo',
  'Europe/Copenhagen',
  'Europe/Helsinki',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Bucharest',
  'Europe/Istanbul',
  'Europe/Kyiv',
  'Europe/Moscow',
  'America/St_Johns',
  'America/Halifax',
  'America/New_York',
  'America/Toronto',
  'America/Chicago',
  'America/Mexico_City',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Vancouver',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Africa/Casablanca',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Nairobi',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
];

export const EVENT_MODES: { value: string; label: string }[] = [
  { value: 'in_person', label: 'In person' },
  { value: 'online', label: 'Online' },
  { value: 'hybrid', label: 'Hybrid' },
];

export function modeLabel(mode: string): string {
  return EVENT_MODES.find((m) => m.value === mode)?.label ?? 'In person';
}
