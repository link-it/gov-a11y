# Integrazione gov-a11y in Jenkins (Linux)

Modello identico a GitHub Actions ma senza la reusable action: si **clona** il tool e lo si
lancia via CLI. L'app tiene la propria config in `ci/a11y/targets.json` (senza credenziali).

```groovy
stage('Accessibilita') {
  steps {
    // 1) l'app deve essere raggiungibile (avviala prima, es. docker compose up -d)
    sh '''
      set -e
      git clone --depth 1 https://github.com/link-it/gov-a11y .gov-a11y
      ( cd .gov-a11y && npm ci )   # postinstall installa Chromium + optional deps (LH/SR)
      node .gov-a11y/a11y-scan.mjs \
        --base "$APP_URL" \
        --config "$WORKSPACE/ci/a11y/targets.json" \
        --out   "$WORKSPACE/a11y-report" \
        --tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa \
        --fail-on serious --fail-on-nameless --screen-reader
    '''
  }
  post {
    always {
      junit 'a11y-report/a11y-junit.xml'
      recordIssues tools: [sarif(pattern: 'a11y-report/a11y.sarif')]   // Warnings NG
      publishHTML target: [reportDir: 'a11y-report', reportFiles: 'report.html', reportName: 'Accessibilita']
    }
  }
}
```

Credenziali per-target: variabili d'ambiente `A11Y_<TARGET>_USER` / `A11Y_<TARGET>_PASS`
(dai credential binding di Jenkins), **mai** nel `targets.json`.

SonarQube: `sonar.externalIssuesReportPaths=a11y-report/sonar-issues.json`.
