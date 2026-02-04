#!/usr/bin/env node
import process from 'node:process'

function getArg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return ''
  }
  return process.argv[index + 1] || ''
}

function requireArg(value, name) {
  if (!value) {
    console.error(`Missing required ${name}`)
    process.exit(1)
  }
}

const clientId = getArg('--client-id')
const clientSecret = getArg('--client-secret')
const redirectUri = getArg('--redirect-uri')
const code = getArg('--code')

requireArg(clientId, 'client id (--client-id)')
requireArg(clientSecret, 'client secret (--client-secret)')
requireArg(redirectUri, 'redirect uri (--redirect-uri)')

const scope = 'https://www.googleapis.com/auth/gmail.readonly'

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('redirect_uri', redirectUri)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', scope)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

if (!code) {
  console.info('Open this URL in your browser to authorize:')
  console.info(authUrl.toString())
  console.info('\nThen re-run with --code <AUTH_CODE>')
  process.exit(0)
}

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code,
  }),
})

if (!tokenResponse.ok) {
  const errorText = await tokenResponse.text()
  console.error('Failed to exchange code for tokens:', errorText)
  process.exit(1)
}

const payload = await tokenResponse.json()
console.info('Token response:')
console.info(JSON.stringify(payload, null, 2))

if (!payload.refresh_token) {
  console.warn('No refresh_token returned. Try again with prompt=consent and a new authorization.')
}
