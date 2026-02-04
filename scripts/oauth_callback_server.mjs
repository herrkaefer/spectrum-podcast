#!/usr/bin/env node
import http from 'node:http'
import process from 'node:process'
import { URL } from 'node:url'

const port = Number.parseInt(process.env.OAUTH_PORT || '3000', 10)

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`)
  if (url.pathname !== '/oauth2callback') {
    res.statusCode = 404
    res.end('Not Found')
    return
  }

  const code = url.searchParams.get('code') || ''
  const error = url.searchParams.get('error') || ''

  if (error) {
    res.statusCode = 400
    res.end(`OAuth error: ${error}`)
    console.error('OAuth error:', error)
    return
  }

  if (!code) {
    res.statusCode = 400
    res.end('Missing code')
    console.error('Missing code in callback')
    return
  }

  console.info('OAuth code:', code)
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('授权成功，你可以回到终端查看 code。')
})

server.listen(port, () => {
  console.info(`OAuth callback server listening on http://localhost:${port}/oauth2callback`)
})
