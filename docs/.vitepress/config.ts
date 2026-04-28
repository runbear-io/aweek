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
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#5f5cf0' }],
  ],

  themeConfig: {
    logo: {
      light: '/logo-dark.svg',
      dark: '/logo-light.svg',
      alt: 'aweek',
    },

    nav: [
      { text: 'Get started', link: '/install' },
      { text: 'Recipes', link: '/recipes/weekly-ops' },
      { text: 'Commands', link: '/commands' },
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
        items: [{ text: 'What is aweek?', link: '/' }],
      },
      {
        text: 'Get started',
        items: [
          { text: 'Install', link: '/install' },
          { text: 'Quickstart', link: '/quickstart' },
        ],
      },
      {
        text: 'Recipes',
        items: [
          { text: 'A weekly operator', link: '/recipes/weekly-ops' },
          { text: 'An engineer', link: '/recipes/engineer' },
          { text: 'A content marketer', link: '/recipes/content-marketer' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Slash commands', link: '/commands' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
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
