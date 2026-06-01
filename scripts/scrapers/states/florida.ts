/**
 * Florida UCC Scraper
 *
 * Scrapes UCC filing data from Florida Secretary of State
 * Uses Puppeteer for real web scraping with anti-detection measures
 */

import { BaseScraper, ScraperResult, SearchOptions } from '../base-scraper'
import puppeteer, { Browser, Page } from 'puppeteer'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PaginationHandler } from '../pagination-handler'

export class FloridaScraper extends BaseScraper {
  private browser: Browser | null = null
  private lastPage: Page | null = null
  private headless: boolean
  private keepPageOpenOnFailure: boolean

  constructor(options: { headless?: boolean; keepPageOpenOnFailure?: boolean } = {}) {
    super({
      state: 'FL',
      baseUrl: 'https://floridaucc.com/search',
      rateLimit: 4, // 4 requests per minute (conservative for privatized system)
      timeout: 45000, // Increased timeout for third-party portal
      retryAttempts: 2
    })
    this.headless = options.headless ?? true
    this.keepPageOpenOnFailure = options.keepPageOpenOnFailure ?? false
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: this.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080',
          '--ignore-certificate-errors'
        ]
      })
    }
    return this.browser
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.lastPage = null
    }
  }

  async captureDiagnostics(
    outputDir: string,
    baseName: string
  ): Promise<{ screenshotPath?: string; htmlPath?: string }> {
    if (!this.lastPage || this.lastPage.isClosed()) {
      return {}
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    const screenshotPath = join(outputDir, `${baseName}.png`)
    const htmlPath = join(outputDir, `${baseName}.html`)

    let savedScreenshot = false
    let savedHtml = false

    try {
      await this.lastPage.screenshot({ path: screenshotPath, fullPage: true })
      savedScreenshot = true
    } catch (error) {
      this.log('warn', 'Failed to capture screenshot', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    try {
      const html = await this.lastPage.content()
      writeFileSync(htmlPath, html)
      savedHtml = true
    } catch (error) {
      this.log('warn', 'Failed to capture HTML snapshot', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return {
      screenshotPath: savedScreenshot ? screenshotPath : undefined,
      htmlPath: savedHtml ? htmlPath : undefined
    }
  }

  /**
   * Search for UCC filings in Florida
   */
  async search(companyName: string, options?: SearchOptions): Promise<ScraperResult> {
    if (!this.validateSearch(companyName)) {
      this.log('error', 'Invalid company name provided', { companyName })
      return {
        success: false,
        error: 'Invalid company name',
        timestamp: new Date().toISOString()
      }
    }

    const searchBy = options?.searchBy ?? 'debtor'
    this.log('info', 'Starting UCC search', { companyName, searchBy })

    // Rate limiting - wait 12 seconds between requests (5 per minute)
    await this.sleep(12000)

    const searchUrl = this.getManualSearchUrl(companyName)

    try {
      const { result, retryCount } = await this.retryWithBackoff(async () => {
        return await this.performSearch(companyName, searchUrl, searchBy)
      }, `FL UCC search for ${companyName}`)

      this.log('info', 'UCC search completed successfully', {
        companyName,
        filingCount: result.filings?.length || 0,
        retryCount
      })

      return {
        ...result,
        retryCount,
        filings: result.filings ? this.filterByDateRange(result.filings, options) : []
      }
    } catch (error) {
      this.log('error', 'UCC search failed after all retries', {
        companyName,
        error: error instanceof Error ? error.message : String(error)
      })

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        searchUrl,
        timestamp: new Date().toISOString()
      }
    }
  }

  /**
   * Perform the actual search operation
   *
   * NOTE: Florida UCC is managed by Image API, LLC through floridaucc.com
   * The search is picky about exact name matches and formatting.
   */
  private async performSearch(
    companyName: string,
    searchUrl: string,
    searchBy: 'debtor' | 'securedParty' = 'debtor'
  ): Promise<ScraperResult> {
    let page: Page | null = null
    let result: ScraperResult | null = null
    const finalize = (next: ScraperResult): ScraperResult => {
      result = next
      return next
    }

    try {
      const browser = await this.getBrowser()
      page = await browser.newPage()
      this.lastPage = page

      this.log('info', 'Browser page created', { companyName })

      // Set user agent and viewport
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )
      await page.setViewport({ width: 1920, height: 1080 })

      // Navigate to Florida UCC search page
      this.log('info', 'Navigating to FL UCC search page', { companyName, searchUrl })
      await page.goto(searchUrl, {
        waitUntil: 'networkidle2',
        timeout: this.config.timeout
      })

      // Wait for page to fully load
      await this.sleep(2000)

      // Check for CAPTCHA early
      const hasCaptcha = await page.evaluate(() => {
        return (
          document.body.innerText.toLowerCase().includes('captcha') ||
          document.body.innerText.toLowerCase().includes('robot') ||
          document.querySelector('iframe[src*="recaptcha"]') !== null ||
          document.querySelector('iframe[src*="hcaptcha"]') !== null
        )
      })

      if (hasCaptcha) {
        this.log('error', 'CAPTCHA detected', { companyName })
        return finalize({
          success: false,
          error: 'CAPTCHA detected - manual intervention required',
          searchUrl: page.url(),
          timestamp: new Date().toISOString()
        })
      }

      // Navigate through the Florida UCC landing flow to reach the search form
      const acknowledged = await page.evaluate(() => {
        const target = Array.from(document.querySelectorAll('button, a')).find(
          (el) => el.textContent?.trim().toLowerCase() === 'ucc search'
        )
        if (target instanceof HTMLElement) {
          target.click()
          return true
        }
        return false
      })

      if (!acknowledged) {
        this.log('warn', 'Could not find UCC search entry point', { companyName })
        return finalize({
          success: false,
          error:
            'Unable to locate UCC search entry point on Florida UCC portal. Portal structure may have changed.',
          searchUrl: page.url(),
          timestamp: new Date().toISOString()
        })
      }

      if (acknowledged) {
        await this.sleep(2000)

        const termsAccepted = await page.evaluate(() => {
          const checkbox = document.querySelector('input[type="checkbox"]')
          if (checkbox instanceof HTMLElement) {
            checkbox.click()
            return true
          }
          return false
        })

        if (!termsAccepted) {
          this.log('info', 'Florida terms acknowledgement checkbox not found; continuing', {
            companyName
          })
        }

        await this.sleep(1200)

        const nextClicked = await page.evaluate(() => {
          const nextButton = Array.from(document.querySelectorAll('button')).find(
            (btn) => (btn.textContent || '').trim().toLowerCase() === 'next'
          )
          if (nextButton instanceof HTMLButtonElement && !nextButton.disabled) {
            nextButton.click()
            return true
          }
          return false
        })

        if (!nextClicked) {
          this.log('info', 'Florida acknowledgement step did not require a Next action', {
            companyName
          })
        }

        await this.sleep(3000)
      }

      // If secured party search, try to select that search type first
      if (searchBy === 'securedParty') {
        await page
          .evaluate(() => {
            // Try dropdown
            const sel = document.querySelector(
              'select[name="searchType"], select[id="searchType"]'
            ) as HTMLSelectElement | null
            if (sel) {
              const opt = Array.from(sel.options).find(
                (o) =>
                  o.value.toLowerCase().includes('secured') ||
                  o.text.toLowerCase().includes('secured')
              )
              if (opt) {
                sel.value = opt.value
                sel.dispatchEvent(new Event('change', { bubbles: true }))
              }
            }
            // Try buttons labeled "Secured Party"
            const btns = Array.from(document.querySelectorAll('button, a')) as HTMLElement[]
            const spBtn = btns.find((b) => b.textContent?.toLowerCase().includes('secured party'))
            if (spBtn) spBtn.click()
            // Try radio buttons
            const radios = Array.from(
              document.querySelectorAll('input[type="radio"]')
            ) as HTMLInputElement[]
            const spRadio = radios.find((r) => {
              const label = document.querySelector(`label[for="${r.id}"]`)
              return (
                label?.textContent?.toLowerCase().includes('secured') ||
                r.value.toLowerCase().includes('secured')
              )
            })
            if (spRadio && !spRadio.checked) spRadio.click()
          })
          .catch(() => {})
        await this.sleep(800)
      }

      // Look for search field (Florida UCC uses a "keyword" or name input)
      const searchFormFilled = await page.evaluate(
        (name, isSP) => {
          const possibleSelectors = isSP
            ? [
                'input[name="securedPartyName"]',
                'input[placeholder*="Secured"]',
                'input[placeholder*="secured"]',
                'input[name="keyword"]',
                'input[placeholder*="Organization"]',
                'input[type="text"]'
              ]
            : [
                'input[name="keyword"]',
                'input[placeholder*="Organization"]',
                'input[placeholder*="organization"]',
                'input[placeholder*="Debtor"]',
                'input[placeholder*="debtor"]',
                'input[type="text"]'
              ]

          for (const selector of possibleSelectors) {
            const input = document.querySelector(selector) as HTMLInputElement | null
            if (input && !input.disabled && input.offsetParent !== null) {
              input.value = name
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
          }
          return false
        },
        companyName,
        searchBy === 'securedParty'
      )

      if (!searchFormFilled) {
        this.log('warn', 'Could not find search field', { companyName, searchBy })
        return {
          success: false,
          error: `Unable to locate ${searchBy === 'securedParty' ? 'secured party' : 'debtor'} name search field on Florida UCC portal. Portal structure may have changed.`,
          searchUrl: page.url(),
          timestamp: new Date().toISOString()
        }
      }

      // Submit the search form
      const formSubmitted = await page.evaluate(() => {
        const searchButton = Array.from(document.querySelectorAll('button')).find(
          (btn) => btn.getAttribute('aria-label')?.toLowerCase() === 'search'
        )

        if (searchButton instanceof HTMLElement) {
          searchButton.click()
          return true
        }

        // Fallback: try form submission
        const form = document.querySelector('form')
        if (form) {
          form.submit()
          return true
        }

        return false
      })

      if (!formSubmitted) {
        this.log('warn', 'Could not submit search form', { companyName })
        return finalize({
          success: false,
          error: 'Unable to submit search form on Florida UCC portal.',
          searchUrl: page.url(),
          timestamp: new Date().toISOString()
        })
      }

      // Wait for results to load
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
      await page
        .waitForFunction(() => window.location.href.includes('/search'), {
          timeout: 15000
        })
        .catch(() => {})
      await this.sleep(3000) // Additional wait for dynamic content

      // Check for "no results" message
      const noResults = await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase()
        return (
          bodyText.includes('no records found') ||
          bodyText.includes('no results') ||
          bodyText.includes('0 results') ||
          bodyText.includes('no filings found')
        )
      })

      if (noResults) {
        this.log('info', 'No UCC filings found', { companyName })
        return finalize({
          success: true,
          filings: [],
          searchUrl: page.url(),
          timestamp: new Date().toISOString()
        })
      }

      // Initialize pagination handler
      const paginationHandler = new PaginationHandler({ maxPages: 10 })
      const allFilings: UCCFiling[] = []
      const allErrors: string[] = []
      let currentPage = 1

      // Pagination loop
      while (true) {
        this.log('info', `Scraping page ${currentPage}`, { companyName })

        // Extract UCC filing data with multiple selector strategies
        const { filings: rawFilings, errors: parseErrors } = await page.evaluate(() => {
          const results: Array<{
            filingNumber: string
            debtorName: string
            securedParty: string
            filingDate: string
            collateral: string
            status: 'active' | 'terminated' | 'lapsed'
            filingType: 'UCC-1' | 'UCC-3'
          }> = []
          const errors: string[] = []

          // Try multiple selector strategies for Florida UCC results
          let resultElements = document.querySelectorAll(
            'table.results tbody tr, table.search-results tbody tr, div.result-row, div.filing-row'
          )

          // Fallback: find any table with multiple rows
          if (resultElements.length === 0) {
            const tables = document.querySelectorAll('table')
            for (const table of tables) {
              const rows = table.querySelectorAll('tbody tr, tr')
              if (rows.length > 1) {
                resultElements = rows
                break
              }
            }
          }

          resultElements.forEach((element, index) => {
            // Skip header rows
            if (element.querySelector('th')) {
              return
            }

            try {
              const cells = element.querySelectorAll('td')

              if (cells.length >= 3) {
                // Common Florida UCC table pattern: filing#, date, debtor, secured party, status
                const filingNumber = cells[0]?.textContent?.trim() || ''
                const filingDate =
                  cells[1]?.textContent?.trim() || cells[2]?.textContent?.trim() || ''
                const debtorName =
                  cells[2]?.textContent?.trim() || cells[1]?.textContent?.trim() || ''
                const securedParty = cells[3]?.textContent?.trim() || ''
                const status =
                  cells[4]?.textContent?.trim() ||
                  cells[cells.length - 1]?.textContent?.trim() ||
                  ''

                if (filingNumber || debtorName) {
                  results.push({
                    filingNumber,
                    debtorName,
                    securedParty,
                    filingDate,
                    collateral: '', // Florida may require detail page navigation
                    status:
                      status.toLowerCase().includes('active') ||
                      status.toLowerCase().includes('filed')
                        ? 'active'
                        : status.toLowerCase().includes('terminated') ||
                            status.toLowerCase().includes('discharged')
                          ? 'terminated'
                          : status.toLowerCase().includes('lapsed') ||
                              status.toLowerCase().includes('expired')
                            ? 'lapsed'
                            : 'active',
                    filingType:
                      filingNumber.toLowerCase().includes('ucc3') ||
                      filingNumber.toLowerCase().includes('ucc-3') ||
                      filingNumber.toLowerCase().includes('amendment')
                        ? 'UCC-3'
                        : 'UCC-1'
                  })
                }
              } else if (element.classList.length > 0) {
                // Try div-based layout
                const filingNumber =
                  element
                    .querySelector('[class*="filing"], [class*="number"]')
                    ?.textContent?.trim() || ''
                const debtorName =
                  element
                    .querySelector('[class*="debtor"], [class*="name"]')
                    ?.textContent?.trim() || ''
                const securedParty =
                  element
                    .querySelector('[class*="secured"], [class*="party"], [class*="creditor"]')
                    ?.textContent?.trim() || ''
                const filingDate =
                  element.querySelector('[class*="date"], [class*="filed"]')?.textContent?.trim() ||
                  ''
                const status = element.querySelector('[class*="status"]')?.textContent?.trim() || ''

                if (filingNumber || debtorName) {
                  results.push({
                    filingNumber,
                    debtorName,
                    securedParty,
                    filingDate,
                    collateral: '',
                    status: status.toLowerCase().includes('active')
                      ? 'active'
                      : status.toLowerCase().includes('terminated')
                        ? 'terminated'
                        : status.toLowerCase().includes('lapsed')
                          ? 'lapsed'
                          : 'active',
                    filingType:
                      filingNumber.toLowerCase().includes('ucc3') ||
                      filingNumber.toLowerCase().includes('ucc-3')
                        ? 'UCC-3'
                        : 'UCC-1'
                  })
                }
              }
            } catch (err) {
              errors.push(
                `Error parsing element ${index}: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          })

          return { filings: results, errors }
        })

        // Add filings and errors from this page
        allFilings.push(...rawFilings)
        allErrors.push(...parseErrors)

        this.log('info', `Page ${currentPage}: Found ${rawFilings.length} raw filings`, {
          companyName
        })

        // Check for pagination
        const pagination = await paginationHandler.detectPagination(page)

        this.log('info', `Pagination detected: ${pagination.paginationType}`, {
          companyName,
          currentPage: pagination.currentPage,
          totalPages: pagination.totalPages,
          hasNextPage: pagination.hasNextPage
        })

        // Check if we should continue to next page
        if (!paginationHandler.shouldContinue(currentPage, pagination)) {
          this.log('info', `Pagination complete at page ${currentPage}`, { companyName })
          break
        }

        // Navigate to next page
        const navigated = await paginationHandler.goToNextPage(page, pagination)

        if (!navigated) {
          this.log('info', 'Could not navigate to next page, stopping pagination', { companyName })
          break
        }

        currentPage++
      }

      // Validate all filings and collect errors
      const { validatedFilings, validationErrors } = this.validateFilings(allFilings, allErrors)

      if (validationErrors.length > 0) {
        this.log('warn', 'Some filings had parsing or validation errors', {
          companyName,
          errorCount: validationErrors.length,
          errors: validationErrors
        })
      }

      this.log('info', 'All filings scraped and validated', {
        companyName,
        totalPages: currentPage,
        rawCount: allFilings.length,
        validCount: validatedFilings.length,
        errorCount: validationErrors.length
      })

      return finalize({
        success: true,
        filings: validatedFilings,
        searchUrl: page.url(),
        timestamp: new Date().toISOString(),
        parsingErrors: validationErrors.length > 0 ? validationErrors : undefined
      })
    } finally {
      if (page) {
        const keepPage = this.keepPageOpenOnFailure && result && !result.success
        if (!keepPage) {
          await page.close().catch((err) => {
            this.log('warn', 'Error closing page', {
              error: err instanceof Error ? err.message : String(err)
            })
          })
        }
      }
    }
  }

  /**
   * Get manual search URL for Florida
   *
   * NOTE: Florida UCC is managed by Image API, LLC at floridaucc.com
   * Direct URL search may not work - users will need to use the search form.
   */
  getManualSearchUrl(companyName: string): string {
    // Florida UCC search supports query params for preloading the search form
    return `${this.config.baseUrl}?text=${encodeURIComponent(companyName)}&searchOptionType=OrganizationDebtorName&searchOptionSubOption=FiledCompactDebtorNameList&searchCategory=Exact`
  }
}
