import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'aweek',
  description:
    'Claude Code plugin for managing AI agents on scheduled weekly plans.',
  base: '/aweek/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/aweek.png' }],
    ['meta', { name: 'theme-color', content: '#5f5cf0' }],
  ],

  themeConfig: {
    logo: '/aweek.png',

    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Skills', link: '/skills' },
      {
        text: 'v0.1.1',
        items: [
          {
            text: 'Changelog',
            link: 'https://github.com/runbear-io/aweek/releases',
          },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is aweek?', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'Slash commands', link: '/skills' }],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/runbear-io/aweek' },
    ],

    editLink: {
      pattern:
        'https://github.com/runbear-io/aweek/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: '© 2026 Runbear, Inc.',
    },
  },
})
