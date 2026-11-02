const express = require('express')
const path = require('path')
const cors = require('cors')
const apiRoutes = require('./app/api/route')

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    }
  }
}))

app.use('/api', apiRoutes)
app.use('/.netlify/functions/api', apiRoutes)

module.exports = app
