# Generates tests/fixtures/alpha_irr.json: random coding tables with missing
# data and the nominal Krippendorff's alpha that R's irr package gives for
# each. The JavaScript implementation is tested against these values.
# Run from the project root:  Rscript tests/fixtures/make_alpha_fixtures.R
library(irr)
library(jsonlite)
set.seed(20261123)
cases <- list()
while (length(cases) < 40) {
  n_coders <- sample(2:5, 1)
  n_items <- sample(8:60, 1)
  n_cats <- sample(2:5, 1)
  p_missing <- sample(c(0, 0.1, 0.3), 1)
  agree <- runif(1, 0.3, 0.95)
  truth <- sample(n_cats, n_items, replace = TRUE, prob = rev(seq_len(n_cats))^2)
  m <- t(sapply(seq_len(n_coders), function(i) {
    ifelse(runif(n_items) < agree, truth, sample(n_cats, n_items, replace = TRUE))
  }))
  m[runif(length(m)) < p_missing] <- NA
  # irr 0.85 skips the division by (codes per item - 1) when a table has no
  # missing values at all, which shifts alpha slightly for 3 or more coders
  # (it then disagrees with Krippendorff's own formula and worked examples).
  # Adding one item that nobody coded sends every table down irr's general
  # path without changing the data.
  a <- suppressWarnings(kripp.alpha(cbind(m, NA), method = "nominal")$value)
  if (!is.finite(a)) next
  cases[[length(cases) + 1]] <- list(
    table = lapply(seq_len(n_coders), function(i) m[i, ]),
    alpha = a
  )
}
write_json(list(source = paste("irr", packageVersion("irr"), "kripp.alpha(method = 'nominal'), general (missing-data) path"), cases = cases),
           "tests/fixtures/alpha_irr.json", digits = NA, na = "null", auto_unbox = TRUE)
cat(length(cases), "cases written\n")
